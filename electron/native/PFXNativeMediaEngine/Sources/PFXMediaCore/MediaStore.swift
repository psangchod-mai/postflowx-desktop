import Foundation
import SQLite3

/// One media asset row in the local database.
public struct MediaRecord: Equatable, Sendable {
    public var id: String          // stable key (e.g. content hash or path)
    public var path: String
    public var filename: String
    public var format: String
    public var codec: String
    public var width: Int
    public var height: Int
    public var fps: Double
    public var durationFrames: Int
    public var sizeBytes: Int64
    public var modified: Double    // epoch seconds
    // Sprint 4 (DB-powered linking): embedded camera metadata so OCF library
    // matching uses filename + timecode without re-running ffprobe each load.
    public var tcIn: String        // container start timecode (HH:MM:SS:FF)
    public var tcOut: String       // computed end timecode
    public var reel: String        // reel / roll id (e.g. A001)

    public init(id: String, path: String, filename: String,
                format: String = "", codec: String = "",
                width: Int = 0, height: Int = 0, fps: Double = 0,
                durationFrames: Int = 0, sizeBytes: Int64 = 0, modified: Double = 0,
                tcIn: String = "", tcOut: String = "", reel: String = "") {
        self.id = id; self.path = path; self.filename = filename
        self.format = format; self.codec = codec
        self.width = width; self.height = height; self.fps = fps
        self.durationFrames = durationFrames; self.sizeBytes = sizeBytes; self.modified = modified
        self.tcIn = tcIn; self.tcOut = tcOut; self.reel = reel
    }
}

public enum MediaStoreError: Error, CustomStringConvertible {
    case open(String)
    case sqlite(String)
    public var description: String {
        switch self {
        case .open(let m):   return "MediaStore open failed: \(m)"
        case .sqlite(let m): return "MediaStore SQLite error: \(m)"
        }
    }
}

/// SQLite-backed media database (PFXMAC Sprint 3).
///
/// Thread-safe: every operation runs on a private serial queue, so the store can
/// be shared across the engine's command handlers. Uses the system `sqlite3`
/// (no third-party dependency). Search is indexed on filename + path for the
/// spec's <100ms target on reasonable libraries.
public final class MediaStore {
    private var db: OpaquePointer?
    private let queue = DispatchQueue(label: "com.postflowx.mediastore")

    // SQLite wants SQLITE_TRANSIENT so it copies bound strings before we free them.
    private static let SQLITE_TRANSIENT = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

    public init(path: String) throws {
        try queue.sync {
            guard sqlite3_open(path, &db) == SQLITE_OK, db != nil else {
                throw MediaStoreError.open(String(cString: sqlite3_errmsg(db)))
            }
            try _exec("PRAGMA journal_mode=WAL;")
            try _exec("PRAGMA synchronous=NORMAL;")
            try _exec("""
                CREATE TABLE IF NOT EXISTS media (
                    id             TEXT PRIMARY KEY,
                    path           TEXT NOT NULL,
                    filename       TEXT NOT NULL,
                    format         TEXT,
                    codec          TEXT,
                    width          INTEGER,
                    height         INTEGER,
                    fps            REAL,
                    durationFrames INTEGER,
                    sizeBytes      INTEGER,
                    modified       REAL,
                    tcIn           TEXT,
                    tcOut          TEXT,
                    reel           TEXT
                );
            """)
            // Migrate older DBs created before the tc/reel columns existed. SQLite
            // has no "ADD COLUMN IF NOT EXISTS", so ignore the error when present.
            for col in ["tcIn TEXT", "tcOut TEXT", "reel TEXT"] {
                try? _exec("ALTER TABLE media ADD COLUMN \(col);")
            }
            try _exec("CREATE INDEX IF NOT EXISTS idx_media_filename ON media(filename);")
            try _exec("CREATE INDEX IF NOT EXISTS idx_media_path     ON media(path);")
            try _exec("CREATE INDEX IF NOT EXISTS idx_media_reel     ON media(reel);")
        }
    }

    /// In-memory store (used by tests and ephemeral sessions).
    public static func inMemory() throws -> MediaStore { try MediaStore(path: ":memory:") }

    deinit { sqlite3_close(db) }

    // MARK: - Public API (all serialized on `queue`)

    /// Insert or update by `id`.
    public func upsert(_ r: MediaRecord) throws {
        try queue.sync {
            let sql = """
                INSERT INTO media (id, path, filename, format, codec, width, height, fps, durationFrames, sizeBytes, modified, tcIn, tcOut, reel)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                ON CONFLICT(id) DO UPDATE SET
                    path=excluded.path, filename=excluded.filename, format=excluded.format,
                    codec=excluded.codec, width=excluded.width, height=excluded.height,
                    fps=excluded.fps, durationFrames=excluded.durationFrames,
                    sizeBytes=excluded.sizeBytes, modified=excluded.modified,
                    tcIn=excluded.tcIn, tcOut=excluded.tcOut, reel=excluded.reel;
            """
            let st = try _prepare(sql)
            defer { sqlite3_finalize(st) }
            _bindText(st, 1, r.id);   _bindText(st, 2, r.path);   _bindText(st, 3, r.filename)
            _bindText(st, 4, r.format); _bindText(st, 5, r.codec)
            sqlite3_bind_int(st, 6, Int32(r.width)); sqlite3_bind_int(st, 7, Int32(r.height))
            sqlite3_bind_double(st, 8, r.fps); sqlite3_bind_int(st, 9, Int32(r.durationFrames))
            sqlite3_bind_int64(st, 10, r.sizeBytes); sqlite3_bind_double(st, 11, r.modified)
            _bindText(st, 12, r.tcIn); _bindText(st, 13, r.tcOut); _bindText(st, 14, r.reel)
            guard sqlite3_step(st) == SQLITE_DONE else { throw _sqliteError() }
        }
    }

    public func get(id: String) throws -> MediaRecord? {
        try queue.sync {
            let st = try _prepare("SELECT \(Self.cols) FROM media WHERE id=? LIMIT 1;")
            defer { sqlite3_finalize(st) }
            _bindText(st, 1, id)
            return sqlite3_step(st) == SQLITE_ROW ? Self._row(st) : nil
        }
    }

    /// Case-insensitive substring search over filename + path.
    public func search(_ term: String, limit: Int = 100) throws -> [MediaRecord] {
        try queue.sync {
            let st = try _prepare("""
                SELECT \(Self.cols) FROM media
                WHERE filename LIKE ? OR path LIKE ?
                ORDER BY filename LIMIT ?;
            """)
            defer { sqlite3_finalize(st) }
            let like = "%\(term)%"
            _bindText(st, 1, like); _bindText(st, 2, like)
            sqlite3_bind_int(st, 3, Int32(limit))
            var out: [MediaRecord] = []
            while sqlite3_step(st) == SQLITE_ROW { out.append(Self._row(st)) }
            return out
        }
    }

    public func count() throws -> Int {
        try queue.sync {
            let st = try _prepare("SELECT COUNT(*) FROM media;")
            defer { sqlite3_finalize(st) }
            return sqlite3_step(st) == SQLITE_ROW ? Int(sqlite3_column_int(st, 0)) : 0
        }
    }

    @discardableResult
    public func delete(id: String) throws -> Bool {
        try queue.sync {
            let st = try _prepare("DELETE FROM media WHERE id=?;")
            defer { sqlite3_finalize(st) }
            _bindText(st, 1, id)
            guard sqlite3_step(st) == SQLITE_DONE else { throw _sqliteError() }
            return sqlite3_changes(db) > 0
        }
    }

    // MARK: - Internals

    private static let cols = "id, path, filename, format, codec, width, height, fps, durationFrames, sizeBytes, modified, tcIn, tcOut, reel"

    private func _exec(_ sql: String) throws {
        var errMsg: UnsafeMutablePointer<CChar>?
        if sqlite3_exec(db, sql, nil, nil, &errMsg) != SQLITE_OK {
            let m = errMsg.map { String(cString: $0) } ?? "unknown"
            sqlite3_free(errMsg)
            throw MediaStoreError.sqlite(m)
        }
    }

    private func _prepare(_ sql: String) throws -> OpaquePointer? {
        var st: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &st, nil) == SQLITE_OK else { throw _sqliteError() }
        return st
    }

    private func _bindText(_ st: OpaquePointer?, _ idx: Int32, _ value: String) {
        sqlite3_bind_text(st, idx, value, -1, Self.SQLITE_TRANSIENT)
    }

    private func _sqliteError() -> MediaStoreError {
        MediaStoreError.sqlite(String(cString: sqlite3_errmsg(db)))
    }

    private static func _str(_ st: OpaquePointer?, _ i: Int32) -> String {
        guard let c = sqlite3_column_text(st, i) else { return "" }
        return String(cString: c)
    }

    private static func _row(_ st: OpaquePointer?) -> MediaRecord {
        MediaRecord(
            id: _str(st, 0), path: _str(st, 1), filename: _str(st, 2),
            format: _str(st, 3), codec: _str(st, 4),
            width: Int(sqlite3_column_int(st, 5)), height: Int(sqlite3_column_int(st, 6)),
            fps: sqlite3_column_double(st, 7), durationFrames: Int(sqlite3_column_int(st, 8)),
            sizeBytes: sqlite3_column_int64(st, 9), modified: sqlite3_column_double(st, 10),
            tcIn: _str(st, 11), tcOut: _str(st, 12), reel: _str(st, 13)
        )
    }
}
