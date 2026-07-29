"""imf_mic.py — MXF EssenceIntegrityPack (message-integrity-code / MIC) verification.

Parses an MXF track file at the KLV level to locate the embedded essence-integrity
structure and verifies that the recorded essence digest matches a digest recomputed
over the actual essence-container bytes in the file's body partitions.

Background
──────────
An MXF file is a flat sequence of KLV (Key-Length-Value) triplets. It is organised
into *partitions*; each partition begins with a Partition Pack KLV and may be
followed by header metadata, index tables and *essence container* KLVs (the picture
/ sound / data payload). SMPTE ST 377-1 / ST 429-6 define an optional per-partition
integrity mechanism where a digest (a "message integrity code", MIC) is computed
over the essence-container elements and stored so a reader can detect corruption or
tampering without re-hashing the whole file against an external Packing List.

This module implements two complementary things:

1. A minimal, dependency-free KLV reader (`iter_klv`, `read_ber_length`) that walks
   the file and classifies each triplet by its 16-byte Universal Label.

2. `verify_mxf_mic(path)` which:
     • finds every essence-container element (KLV whose key is in the
       "GC / Essence Element" or "Generic Container" range),
     • recomputes the essence digest exactly as the writer did
       (SHA-1 / SHA-256 over the concatenated essence-element *values*, in file
       order — this is the algorithm asdcplib uses for its EssenceIntegrityPack),
     • locates the EssenceIntegrityPack KLV, extracts the stored algorithm + digest,
     • compares them and reports pass / fail.

If a file carries no EssenceIntegrityPack the result is gated as ``present=False``
(NOT a failure) so callers can surface "no embedded MIC to verify" rather than
crashing or reporting a false negative.

The synthesized-fixture writer (`build_mxf_with_mic`) produces a byte-exact MXF
skeleton with a real EssenceIntegrityPack so the algorithm can be unit-tested
end-to-end without external media.
"""
from __future__ import annotations

import hashlib
import struct
from dataclasses import dataclass
from pathlib import Path
from typing import Any, BinaryIO, Iterator


# ── Universal Labels ──────────────────────────────────────────────────────────
# 16-byte SMPTE keys. We compare on a masked prefix where the spec allows the
# registry/version byte and the element-count/number bytes to vary.

# Partition Pack keys all share this 13-byte prefix (byte 13 = kind, 14 = status).
#   06 0e 2b 34 02 05 01 01  0d 01 02 01 01 <kind> <status> 00
_PARTITION_PREFIX = bytes.fromhex("060e2b34020501010d01020101")

# Primer pack (local-tag → UL mapping) — we skip its body, we only need to walk past.
_PRIMER_KEY = bytes.fromhex("060e2b34020501010d01020101050100")

# Header/Body/Footer metadata & index — walked over, not needed for the digest.
_INDEX_TABLE_PREFIX = bytes.fromhex("060e2b34020501010d01020101100100")

# Generic Container / Essence Element keys.
#   06 0e 2b 34 01 02 01 01  0d 01 03 01 <item-type> <element-type> <element-count> <element-number>
# The last four bytes identify the specific essence track/element and vary per file,
# so we match on the 12-byte "Generic Container Essence Element" prefix.
_GC_ESSENCE_PREFIX = bytes.fromhex("060e2b34010201010d010301")

# EssenceIntegrityPack key (SMPTE ST 429-6 §; asdcplib "Message Integrity Code").
#   06 0e 2b 34 02 05 01 01  0d 01 04 01 02 01 00 00
_ESSENCE_INTEGRITY_PACK_KEY = bytes.fromhex("060e2b34020501010d01040102010000")

# Digest algorithm identifiers stored in the pack (1 byte).
_ALG_SHA1 = 0x01
_ALG_SHA256 = 0x02
_ALG_NAMES = {_ALG_SHA1: "SHA-1", _ALG_SHA256: "SHA-256"}
_ALG_HASHLIB = {_ALG_SHA1: hashlib.sha1, _ALG_SHA256: hashlib.sha256}


class MxfParseError(Exception):
    """Raised when the file is not a well-formed MXF KLV stream."""


# ── low-level KLV reading ───────────────────────────────────────────────────────

def read_ber_length(f: BinaryIO) -> int:
    """Read a BER-encoded length (SMPTE 377-1). Returns the decoded integer.

    Short form: a single byte 0x00–0x7f is the length itself.
    Long form:  0x80 | n  →  the next n bytes are the big-endian length.
    """
    first = f.read(1)
    if not first:
        raise MxfParseError("truncated BER length")
    b0 = first[0]
    if b0 < 0x80:
        return b0
    n = b0 & 0x7F
    if n == 0:
        # Indefinite form is not permitted in MXF.
        raise MxfParseError("indefinite BER length not allowed in MXF")
    raw = f.read(n)
    if len(raw) != n:
        raise MxfParseError("truncated long-form BER length")
    return int.from_bytes(raw, "big")


def encode_ber_length(length: int, num_bytes: int = 4) -> bytes:
    """Encode a length in BER long form using a fixed byte count (MXF convention).

    MXF writers almost always use 4-byte long-form lengths for top-level KLVs.
    """
    if length < 0:
        raise ValueError("length must be non-negative")
    if num_bytes < 1 or num_bytes > 8:
        raise ValueError("num_bytes out of range")
    return bytes([0x80 | num_bytes]) + length.to_bytes(num_bytes, "big")


@dataclass
class KlvTriplet:
    key: bytes            # 16-byte Universal Label
    length: int           # decoded value length
    value_offset: int     # absolute file offset of the value
    header_len: int       # bytes consumed by key + BER length


def iter_klv(f: BinaryIO) -> Iterator[KlvTriplet]:
    """Yield each top-level KLV triplet in the stream without loading values."""
    while True:
        start = f.tell()
        key = f.read(16)
        if not key:
            return
        if len(key) != 16:
            raise MxfParseError(f"truncated KLV key at offset {start}")
        length = read_ber_length(f)
        value_offset = f.tell()
        header_len = value_offset - start
        yield KlvTriplet(key=key, length=length, value_offset=value_offset,
                         header_len=header_len)
        # Advance past the value.
        f.seek(value_offset + length)


def _key_has_prefix(key: bytes, prefix: bytes) -> bool:
    return key[: len(prefix)] == prefix


def is_partition_pack(key: bytes) -> bool:
    # bytes 0..12 fixed, byte 13 = partition kind (02 header,03 body,04 footer),
    # byte 14 = open/closed+complete/incomplete status, byte 15 = 0x00.
    return _key_has_prefix(key, _PARTITION_PREFIX) and key[15] == 0x00


def is_essence_element(key: bytes) -> bool:
    return _key_has_prefix(key, _GC_ESSENCE_PREFIX)


def is_integrity_pack(key: bytes) -> bool:
    return key == _ESSENCE_INTEGRITY_PACK_KEY


# ── EssenceIntegrityPack value layout ───────────────────────────────────────────
# The pack value is a small local-set of 2-byte-tag / 2-byte-length items:
#   tag 0x8001  DigestAlgorithm   (1 byte: 0x01 SHA-1, 0x02 SHA-256)
#   tag 0x8002  EssenceLength     (8 bytes: total essence bytes covered, big-endian)
#   tag 0x8003  Digest            (algorithm-dependent length: 20 or 32 bytes)
# This mirrors asdcplib's MIC set; tags are in the "dark" (0x8000+) range because the
# concrete SMPTE local tags are assigned via the Primer, which we do not need to read
# for a self-describing fixed layout.

_TAG_ALG = 0x8001
_TAG_ESSENCE_LEN = 0x8002
_TAG_DIGEST = 0x8003


@dataclass
class IntegrityPack:
    algorithm: int
    essence_length: int
    digest: bytes


def parse_integrity_pack(value: bytes) -> IntegrityPack:
    alg: int | None = None
    ess_len: int | None = None
    digest: bytes | None = None
    pos = 0
    n = len(value)
    while pos + 4 <= n:
        tag, size = struct.unpack_from(">HH", value, pos)
        pos += 4
        if pos + size > n:
            raise MxfParseError("integrity-pack item overruns value")
        item = value[pos:pos + size]
        pos += size
        if tag == _TAG_ALG and size >= 1:
            alg = item[0]
        elif tag == _TAG_ESSENCE_LEN and size == 8:
            ess_len = int.from_bytes(item, "big")
        elif tag == _TAG_DIGEST:
            digest = item
    if alg is None or digest is None:
        raise MxfParseError("integrity pack missing algorithm or digest")
    return IntegrityPack(
        algorithm=alg,
        essence_length=ess_len if ess_len is not None else 0,
        digest=digest,
    )


def build_integrity_pack_value(algorithm: int, essence_length: int, digest: bytes) -> bytes:
    def item(tag: int, data: bytes) -> bytes:
        return struct.pack(">HH", tag, len(data)) + data
    return b"".join([
        item(_TAG_ALG, bytes([algorithm])),
        item(_TAG_ESSENCE_LEN, essence_length.to_bytes(8, "big")),
        item(_TAG_DIGEST, digest),
    ])


# ── verification ─────────────────────────────────────────────────────────────

@dataclass
class MicResult:
    path: str
    present: bool = False            # was an EssenceIntegrityPack found?
    ok: bool | None = None           # None when not present; else pass/fail
    algorithm: str = ""
    essence_bytes: int = 0
    stored_digest: str = ""
    computed_digest: str = ""
    essence_element_count: int = 0
    error: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "path": self.path,
            "present": self.present,
            "ok": self.ok,
            "algorithm": self.algorithm,
            "essenceBytes": self.essence_bytes,
            "storedDigest": self.stored_digest,
            "computedDigest": self.computed_digest,
            "essenceElementCount": self.essence_element_count,
            "error": self.error,
        }


def _digest_over_essence(f: BinaryIO, elements: list[KlvTriplet], algorithm: int) -> tuple[bytes, int]:
    """Recompute the essence digest over the *values* of essence-element KLVs.

    Reads in bounded chunks so a large body partition never loads fully into RAM.
    Returns (digest_bytes, total_essence_bytes).
    """
    hasher_factory = _ALG_HASHLIB.get(algorithm)
    if hasher_factory is None:
        raise MxfParseError(f"unsupported digest algorithm 0x{algorithm:02x}")
    hasher = hasher_factory()
    total = 0
    chunk = 1 << 20  # 1 MiB
    for el in elements:
        f.seek(el.value_offset)
        remaining = el.length
        while remaining > 0:
            block = f.read(min(chunk, remaining))
            if not block:
                raise MxfParseError("truncated essence element value")
            hasher.update(block)
            remaining -= len(block)
        total += el.length
    return hasher.digest(), total


def verify_mxf_mic(path: str | Path) -> MicResult:
    """Verify the embedded EssenceIntegrityPack (MIC) of an MXF track file.

    Never raises for content problems — returns a MicResult with ``error`` set or
    ``present=False``. Only genuinely unexpected I/O errors bubble up as ``error``.
    """
    p = Path(path)
    result = MicResult(path=str(p))

    if not p.is_file():
        result.error = f"file not found: {p}"
        return result

    try:
        with p.open("rb") as f:
            # First pass: sanity-check that this is an MXF (starts with a partition pack).
            header = f.read(16)
            if len(header) != 16 or not is_partition_pack(header):
                result.error = "not an MXF file (missing header partition pack)"
                return result
            f.seek(0)

            # Each EssenceIntegrityPack (ST 429-6) covers only the essence elements
            # written since the previous one -- a multi-partition MXF can carry one
            # pack per body partition. Bucket elements per pack rather than
            # aggregating the whole file into a single digest, otherwise every pack
            # but the last is silently discarded and a valid multi-partition file
            # reads as tampered (or a truncated one reads as clean).
            essence_elements: list[KlvTriplet] = []
            pack_count = 0
            total_essence_bytes = 0
            total_essence_elements = 0
            all_ok = True
            first_error: str | None = None

            for kl in iter_klv(f):
                if is_essence_element(kl.key):
                    essence_elements.append(kl)
                elif is_integrity_pack(kl.key):
                    pack_count += 1
                    cur = f.tell()
                    f.seek(kl.value_offset)
                    integrity_value = f.read(kl.length)
                    f.seek(cur)

                    pack = parse_integrity_pack(integrity_value)
                    result.algorithm = _ALG_NAMES.get(pack.algorithm, f"0x{pack.algorithm:02x}")
                    result.stored_digest = pack.digest.hex()

                    computed, total = _digest_over_essence(f, essence_elements, pack.algorithm)
                    result.computed_digest = computed.hex()
                    total_essence_bytes += total
                    total_essence_elements += len(essence_elements)

                    digest_match = computed == pack.digest
                    # If the pack recorded an essence length, it must also agree.
                    length_match = (pack.essence_length == 0) or (pack.essence_length == total)
                    if not (digest_match and length_match):
                        all_ok = False
                        if first_error is None:
                            if not digest_match:
                                first_error = "essence digest mismatch (file corrupt or tampered)"
                            else:
                                first_error = (
                                    f"essence length mismatch: pack={pack.essence_length} "
                                    f"bytes, computed={total} bytes"
                                )
                    essence_elements = []

            result.essence_element_count = total_essence_elements
            result.essence_bytes = total_essence_bytes

            if pack_count == 0:
                # Cleanly gate: no embedded MIC present.
                result.present = False
                result.ok = None
                result.algorithm = ""
                result.stored_digest = ""
                result.computed_digest = ""
                return result

            result.present = True
            result.ok = all_ok
            if not result.ok:
                result.error = first_error
            return result
    except MxfParseError as exc:
        result.error = f"MXF parse error: {exc}"
        return result
    except OSError as exc:
        result.error = f"I/O error: {exc}"
        return result


# ── synthesized fixture writer (for tests / dev) ────────────────────────────────

def _partition_pack_key(kind: int, status: int = 0x01) -> bytes:
    """kind: 0x02 header, 0x03 body, 0x04 footer. status: closed+complete=0x01."""
    return _PARTITION_PREFIX + bytes([kind, status, 0x00])


def _essence_element_key(element_number: int = 0x01) -> bytes:
    # Generic Container / picture essence element (frame-wrapped).
    #   ...0d 01 03 01  15 01 <element-count> <element-number>
    return _GC_ESSENCE_PREFIX + bytes([0x15, 0x01, 0x01, element_number & 0xFF])


def _klv(key: bytes, value: bytes) -> bytes:
    return key + encode_ber_length(len(value)) + value


def build_mxf_with_mic(
    essence_chunks: list[bytes],
    algorithm: int = _ALG_SHA1,
    *,
    corrupt_digest: bool = False,
    omit_pack: bool = False,
    wrong_length: bool = False,
) -> bytes:
    """Build a minimal but structurally-valid MXF byte stream carrying a real MIC.

    Layout:  [header partition pack] [essence element]* [EssenceIntegrityPack]
             [footer partition pack]

    The digest is computed exactly as ``verify_mxf_mic`` recomputes it, so a clean
    build round-trips to ``ok=True``. The corrupt_* flags synthesize failing files.
    """
    hasher_factory = _ALG_HASHLIB[algorithm]
    hasher = hasher_factory()
    total = 0
    for c in essence_chunks:
        hasher.update(c)
        total += len(c)
    digest = hasher.digest()
    if corrupt_digest:
        digest = bytes((b ^ 0xFF) for b in digest)

    out = bytearray()
    # Header partition pack — value content is irrelevant to MIC; keep it small.
    out += _klv(_partition_pack_key(0x02), b"\x00" * 8)
    # Essence elements.
    for i, c in enumerate(essence_chunks):
        out += _klv(_essence_element_key(i + 1), c)
    # EssenceIntegrityPack.
    if not omit_pack:
        recorded_len = (total + 1) if wrong_length else total
        pack_val = build_integrity_pack_value(algorithm, recorded_len, digest)
        out += _klv(_ESSENCE_INTEGRITY_PACK_KEY, pack_val)
    # Footer partition pack.
    out += _klv(_partition_pack_key(0x04), b"\x00" * 8)
    return bytes(out)


# ── batch helper for the QC flow ─────────────────────────────────────────────

def verify_mic_for_assets(mxf_paths: list[str | Path]) -> dict[str, Any]:
    """Verify MICs for a list of MXF files and roll up an overall status.

    Returns:
        {
          "checked": int,          # files with an embedded MIC that we verified
          "passed": int,
          "failed": int,
          "absent": int,           # files with no embedded MIC (cleanly gated)
          "unreadable": int,       # files we could not parse
          "overallStatus": "pass" | "fail" | "skip",
          "results": [MicResult.to_dict(), ...],
        }
    """
    results: list[dict[str, Any]] = []
    passed = failed = absent = unreadable = 0
    for path in mxf_paths:
        r = verify_mxf_mic(path)
        results.append(r.to_dict())
        if r.error and not r.present:
            unreadable += 1
        elif not r.present:
            absent += 1
        elif r.ok:
            passed += 1
        else:
            failed += 1

    checked = passed + failed
    if failed > 0:
        overall = "fail"
    elif checked > 0:
        overall = "pass"
    else:
        overall = "skip"  # nothing had an embedded MIC to verify

    return {
        "checked": checked,
        "passed": passed,
        "failed": failed,
        "absent": absent,
        "unreadable": unreadable,
        "overallStatus": overall,
        "results": results,
    }
