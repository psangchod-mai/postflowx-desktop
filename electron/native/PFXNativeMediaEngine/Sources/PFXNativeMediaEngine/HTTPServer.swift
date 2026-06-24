// HTTPServer.swift — NWListener-based HTTP/1.1 server (no third-party deps)

import Foundation
import Network

final class HTTPServer {
    private let router: CommandRouter
    private var listener: NWListener?
    private let queue = DispatchQueue(label: "com.pfx.httpserver", attributes: .concurrent)
    private(set) var port: UInt16 = 0

    init(router: CommandRouter) {
        self.router = router
    }

    func start() throws -> UInt16 {
        let params = NWParameters.tcp
        params.allowLocalEndpointReuse = true

        let listener = try NWListener(using: params)
        self.listener = listener

        let sem = DispatchSemaphore(value: 0)

        listener.stateUpdateHandler = { [weak self] state in
            switch state {
            case .ready:
                if let p = listener.port { self?.port = p.rawValue }
                sem.signal()
            case .failed(let err):
                fputs("HTTPServer listener failed: \(err)\n", stderr)
                sem.signal()
            default: break
            }
        }

        listener.newConnectionHandler = { [weak self] conn in self?.handleConnection(conn) }
        listener.start(queue: queue)
        sem.wait()

        guard port != 0 else {
            throw NSError(domain: "PFXNativeMediaEngine", code: 1,
                userInfo: [NSLocalizedDescriptionKey: "Failed to bind port"])
        }
        return port
    }

    // ── Connection handling ────────────────────────────────────────────────────

    private func handleConnection(_ connection: NWConnection) {
        connection.start(queue: queue)
        receive(connection: connection, accumulated: Data())
    }

    private func receive(connection: NWConnection, accumulated: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, done, _ in
            guard let self else { return }
            var buf = accumulated
            if let d = data { buf.append(d) }

            // Locate end of HTTP headers
            guard let sep = buf.range(of: Data("\r\n\r\n".utf8)) else {
                if done { connection.cancel(); return }
                self.receive(connection: connection, accumulated: buf)
                return
            }

            let headerStr  = String(data: buf[buf.startIndex..<sep.lowerBound], encoding: .utf8) ?? ""
            let bodyOffset = sep.upperBound
            var contentLen = 0
            for line in headerStr.components(separatedBy: "\r\n") {
                if line.lowercased().hasPrefix("content-length:") {
                    contentLen = Int(line.dropFirst(15).trimmingCharacters(in: .whitespaces)) ?? 0
                }
            }

            let bodyData = buf[bodyOffset...]
            if bodyData.count >= contentLen {
                self.dispatch(headerStr: headerStr, body: Data(bodyData.prefix(contentLen)), connection: connection)
            } else {
                let need = contentLen - bodyData.count
                connection.receive(minimumIncompleteLength: need, maximumLength: need) { [weak self] extra, _, _, _ in
                    var full = Data(bodyData)
                    if let e = extra { full.append(e) }
                    self?.dispatch(headerStr: headerStr, body: full, connection: connection)
                }
            }
        }
    }

    private func dispatch(headerStr: String, body: Data, connection: NWConnection) {
        let requestLine = headerStr.components(separatedBy: "\r\n").first ?? ""
        let parts  = requestLine.components(separatedBy: " ")
        let method = parts.count > 0 ? parts[0] : "GET"
        let path   = parts.count > 1 ? parts[1] : "/"

        if method == "OPTIONS" {
            respond(connection: connection, status: 204, body: Data())
            return
        }
        if path == "/health" {
            let body = (try? JSONSerialization.data(withJSONObject: ["ok": true, "engine": "PFXNativeMediaEngine"])) ?? Data()
            respond(connection: connection, status: 200, body: body)
            return
        }
        guard path == "/command", method == "POST" else {
            respond(connection: connection, status: 404, body: Data(#"{"ok":false,"error":"Not found"}"#.utf8))
            return
        }
        guard let cmd = try? JSONSerialization.jsonObject(with: body) as? [String: Any] else {
            respond(connection: connection, status: 400, body: Data(#"{"ok":false,"error":"Invalid JSON"}"#.utf8))
            return
        }

        let reqId   = cmd["id"] as? String ?? ""
        let type    = cmd["type"] as? String ?? ""
        let payload = cmd["payload"] as? [String: Any] ?? [:]

        Task {
            do {
                let result = try await self.router.route(type: type, payload: payload)
                var resp: [String: Any] = ["ok": true, "data": result]
                if !reqId.isEmpty { resp["id"] = reqId }
                let data = (try? JSONSerialization.data(withJSONObject: resp)) ?? Data()
                self.respond(connection: connection, status: 200, body: data)
            } catch {
                var resp: [String: Any] = ["ok": false, "error": error.localizedDescription]
                if !reqId.isEmpty { resp["id"] = reqId }
                let data = (try? JSONSerialization.data(withJSONObject: resp)) ?? Data()
                self.respond(connection: connection, status: 200, body: data)
            }
        }
    }

    private func respond(connection: NWConnection, status: Int, body: Data,
                         extraHeaders: [String: String] = [:]) {
        var headers = [
            "Content-Type": "application/json",
            "Content-Length": "\(body.count)",
            "Access-Control-Allow-Origin": "*",
            "Connection": "close",
        ]
        extraHeaders.forEach { headers[$0] = $1 }

        let statusText: String
        switch status {
        case 200: statusText = "OK"
        case 204: statusText = "No Content"
        case 400: statusText = "Bad Request"
        case 404: statusText = "Not Found"
        default:  statusText = "Unknown"
        }

        var raw = "HTTP/1.1 \(status) \(statusText)\r\n"
        for (k, v) in headers { raw += "\(k): \(v)\r\n" }
        raw += "\r\n"

        var out = Data(raw.utf8)
        out.append(body)
        connection.send(content: out, completion: .contentProcessed { _ in connection.cancel() })
    }
}
