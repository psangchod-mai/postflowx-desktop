// Plain executable test harness for MediaStore (no XCTest — this machine has
// Command Line Tools only, where XCTest is unavailable). Run: swift run MediaStoreCheck
import Foundation
import PFXMediaCore

var passed = 0, failed = 0
func check(_ cond: Bool, _ label: String) {
    if cond { passed += 1; print("PASS - \(label)") }
    else    { failed += 1; print("FAIL - \(label)") }
}
func sample(_ id: String, _ name: String, path: String? = nil) -> MediaRecord {
    MediaRecord(id: id, path: path ?? "/media/\(name)", filename: name,
                format: "MXF", codec: "ProRes", width: 3840, height: 2160,
                fps: 23.976, durationFrames: 1440, sizeBytes: 12_345_678, modified: 1_700_000_000)
}

do {
    // insert + get
    let s1 = try MediaStore.inMemory()
    try s1.upsert(sample("a1", "shot_010.mxf"))
    check(try s1.get(id: "a1") == sample("a1", "shot_010.mxf"), "insert + get round-trips")
    check(try s1.count() == 1, "count == 1 after one insert")
    check(try s1.get(id: "nope") == nil, "missing id → nil")

    // upsert updates, never duplicates
    let s2 = try MediaStore.inMemory()
    try s2.upsert(sample("a1", "old.mxf"))
    var u = sample("a1", "new.mxf"); u.codec = "DNxHR"
    try s2.upsert(u)
    check(try s2.count() == 1, "upsert same id does not duplicate")
    check(try s2.get(id: "a1")?.filename == "new.mxf", "upsert updates filename")
    check(try s2.get(id: "a1")?.codec == "DNxHR", "upsert updates codec")

    // search by filename + path
    let s3 = try MediaStore.inMemory()
    try s3.upsert(sample("a1", "SQ010_SH0040.mxf", path: "/ocf/reel1/SQ010_SH0040.mxf"))
    try s3.upsert(sample("a2", "SQ010_SH0050.mxf", path: "/ocf/reel1/SQ010_SH0050.mxf"))
    try s3.upsert(sample("a3", "credits.mxf",      path: "/ocf/reel2/credits.mxf"))
    check(try s3.search("SQ010").count == 2, "search by filename substring (2 hits)")
    check(try s3.search("reel2").count == 1, "search by path substring (1 hit)")
    check(try s3.search("SH0050").map(\.id) == ["a2"], "search resolves exact filename")
    check(try s3.search("nomatch").count == 0, "no match → empty")

    // ordered + limited
    let s4 = try MediaStore.inMemory()
    for n in ["c.mxf", "a.mxf", "b.mxf"] { try s4.upsert(sample(n, n)) }
    check(try s4.search(".mxf").map(\.filename) == ["a.mxf", "b.mxf", "c.mxf"], "search ordered by filename")
    check(try s4.search(".mxf", limit: 2).count == 2, "search respects limit")

    // delete
    let s5 = try MediaStore.inMemory()
    try s5.upsert(sample("a1", "x.mxf"))
    check(try s5.delete(id: "a1") == true, "delete existing → true")
    check(try s5.count() == 0, "count 0 after delete")
    check(try s5.delete(id: "a1") == false, "delete missing → false")

    // thread safety
    let s6 = try MediaStore.inMemory()
    DispatchQueue.concurrentPerform(iterations: 200) { i in try? s6.upsert(sample("id\(i)", "f\(i).mxf")) }
    check(try s6.count() == 200, "concurrent upserts are thread-safe (200 rows)")
} catch {
    print("FAIL - threw error: \(error)")
    failed += 1
}

print("\n\(passed) passed, \(failed) failed")
exit(failed == 0 ? 0 : 1)
