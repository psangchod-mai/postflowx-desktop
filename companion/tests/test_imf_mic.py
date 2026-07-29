"""Tests for imf_mic.py — MXF EssenceIntegrityPack (MIC) verification.

Uses the module's own synthesized-fixture writer (build_mxf_with_mic) so the KLV
parser and digest algorithm are exercised end-to-end with no external media.
"""
from __future__ import annotations

import hashlib
import io
import struct

import pytest

from postflowx_companion import imf_mic
from postflowx_companion.imf_mic import (
    MicResult,
    MxfParseError,
    build_integrity_pack_value,
    build_mxf_with_mic,
    encode_ber_length,
    is_essence_element,
    is_integrity_pack,
    is_partition_pack,
    iter_klv,
    parse_integrity_pack,
    read_ber_length,
    verify_mic_for_assets,
    verify_mxf_mic,
    _ALG_SHA1,
    _ALG_SHA256,
    _ESSENCE_INTEGRITY_PACK_KEY,
)


# ── BER length ────────────────────────────────────────────────────────────────

class TestBerLength:
    def test_short_form(self):
        assert read_ber_length(io.BytesIO(bytes([0x7F]))) == 0x7F

    def test_short_form_zero(self):
        assert read_ber_length(io.BytesIO(bytes([0x00]))) == 0

    def test_long_form_one_byte(self):
        assert read_ber_length(io.BytesIO(bytes([0x81, 0xFF]))) == 255

    def test_long_form_four_bytes(self):
        raw = bytes([0x84]) + (0x01020304).to_bytes(4, "big")
        assert read_ber_length(io.BytesIO(raw)) == 0x01020304

    def test_indefinite_rejected(self):
        with pytest.raises(MxfParseError):
            read_ber_length(io.BytesIO(bytes([0x80])))

    def test_truncated_rejected(self):
        with pytest.raises(MxfParseError):
            read_ber_length(io.BytesIO(bytes([0x84, 0x00])))

    def test_encode_roundtrip(self):
        for n in (0, 1, 127, 128, 255, 65535, 1 << 20):
            enc = encode_ber_length(n, 4)
            assert read_ber_length(io.BytesIO(enc)) == n


# ── key classification ──────────────────────────────────────────────────────

class TestKeyClassification:
    def test_partition_pack_recognised(self):
        key = bytes.fromhex("060e2b34020501010d01020101020100")  # header, closed
        assert is_partition_pack(key)

    def test_footer_partition_recognised(self):
        key = bytes.fromhex("060e2b34020501010d01020101040100")  # footer
        assert is_partition_pack(key)

    def test_essence_element_recognised(self):
        key = bytes.fromhex("060e2b34010201010d01030115010101")
        assert is_essence_element(key)

    def test_integrity_pack_recognised(self):
        assert is_integrity_pack(_ESSENCE_INTEGRITY_PACK_KEY)

    def test_essence_not_partition(self):
        key = bytes.fromhex("060e2b34010201010d01030115010101")
        assert not is_partition_pack(key)


# ── iter_klv ─────────────────────────────────────────────────────────────────

class TestIterKlv:
    def test_walks_all_triplets(self):
        data = build_mxf_with_mic([b"AAAA", b"BBBB"])
        f = io.BytesIO(data)
        keys = [kl.key for kl in iter_klv(f)]
        # header PP, 2 essence, integrity pack, footer PP
        assert len(keys) == 5
        assert is_partition_pack(keys[0])
        assert is_essence_element(keys[1])
        assert is_essence_element(keys[2])
        assert is_integrity_pack(keys[3])
        assert is_partition_pack(keys[4])

    def test_value_offset_points_at_value(self):
        data = build_mxf_with_mic([b"HELLO"])
        f = io.BytesIO(data)
        elements = [kl for kl in iter_klv(f) if is_essence_element(kl.key)]
        assert len(elements) == 1
        f.seek(elements[0].value_offset)
        assert f.read(elements[0].length) == b"HELLO"

    def test_truncated_key_raises(self):
        with pytest.raises(MxfParseError):
            list(iter_klv(io.BytesIO(b"\x06\x0e\x2b")))  # 3 bytes, partial key


# ── integrity pack (de)serialisation ─────────────────────────────────────────

class TestIntegrityPack:
    def test_roundtrip_sha1(self):
        digest = hashlib.sha1(b"x").digest()
        val = build_integrity_pack_value(_ALG_SHA1, 12345, digest)
        pack = parse_integrity_pack(val)
        assert pack.algorithm == _ALG_SHA1
        assert pack.essence_length == 12345
        assert pack.digest == digest

    def test_roundtrip_sha256(self):
        digest = hashlib.sha256(b"y").digest()
        val = build_integrity_pack_value(_ALG_SHA256, 7, digest)
        pack = parse_integrity_pack(val)
        assert pack.algorithm == _ALG_SHA256
        assert pack.digest == digest

    def test_missing_digest_raises(self):
        # only the algorithm item
        val = struct.pack(">HH", 0x8001, 1) + bytes([_ALG_SHA1])
        with pytest.raises(MxfParseError):
            parse_integrity_pack(val)


# ── end-to-end verify ────────────────────────────────────────────────────────

class TestVerifyMxfMic:
    def _write(self, tmp_path, data, name="video.mxf"):
        p = tmp_path / name
        p.write_bytes(data)
        return p

    def test_valid_sha1_passes(self, tmp_path):
        data = build_mxf_with_mic([b"frame0", b"frame1"], _ALG_SHA1)
        p = self._write(tmp_path, data)
        r = verify_mxf_mic(p)
        assert r.present is True
        assert r.ok is True
        assert r.algorithm == "SHA-1"
        assert r.essence_element_count == 2
        assert r.essence_bytes == len(b"frame0") + len(b"frame1")
        assert r.error is None

    def test_valid_sha256_passes(self, tmp_path):
        data = build_mxf_with_mic([b"payload"], _ALG_SHA256)
        p = self._write(tmp_path, data)
        r = verify_mxf_mic(p)
        assert r.ok is True
        assert r.algorithm == "SHA-256"

    def test_digest_matches_manual_hash(self, tmp_path):
        chunks = [b"aaa", b"bbbbb", b"c"]
        data = build_mxf_with_mic(chunks, _ALG_SHA1)
        p = self._write(tmp_path, data)
        r = verify_mxf_mic(p)
        expected = hashlib.sha1(b"".join(chunks)).hexdigest()
        assert r.computed_digest == expected
        assert r.stored_digest == expected

    def test_corrupt_digest_fails(self, tmp_path):
        data = build_mxf_with_mic([b"frame0"], corrupt_digest=True)
        p = self._write(tmp_path, data)
        r = verify_mxf_mic(p)
        assert r.present is True
        assert r.ok is False
        assert "mismatch" in (r.error or "")

    def test_tampered_essence_fails(self, tmp_path):
        # Build a valid file then flip a byte inside the essence element value.
        data = bytearray(build_mxf_with_mic([b"frame0000"]))
        # Locate essence value and mutate it.
        f = io.BytesIO(bytes(data))
        el = next(kl for kl in iter_klv(f) if is_essence_element(kl.key))
        data[el.value_offset] ^= 0xFF
        p = self._write(tmp_path, bytes(data))
        r = verify_mxf_mic(p)
        assert r.ok is False

    def test_wrong_length_fails(self, tmp_path):
        data = build_mxf_with_mic([b"frame0"], wrong_length=True)
        p = self._write(tmp_path, data)
        r = verify_mxf_mic(p)
        assert r.ok is False
        assert "length mismatch" in (r.error or "")

    def test_absent_pack_gates_cleanly(self, tmp_path):
        data = build_mxf_with_mic([b"frame0"], omit_pack=True)
        p = self._write(tmp_path, data)
        r = verify_mxf_mic(p)
        assert r.present is False
        assert r.ok is None
        assert r.error is None  # not an error — just nothing to verify

    def test_non_mxf_gated(self, tmp_path):
        p = self._write(tmp_path, b"this is not an mxf file at all........", "bad.mxf")
        r = verify_mxf_mic(p)
        assert r.present is False
        assert "not an MXF" in (r.error or "")

    def test_missing_file(self, tmp_path):
        r = verify_mxf_mic(tmp_path / "nope.mxf")
        assert r.present is False
        assert "not found" in (r.error or "")

    def test_result_to_dict_shape(self, tmp_path):
        data = build_mxf_with_mic([b"z"])
        p = self._write(tmp_path, data)
        d = verify_mxf_mic(p).to_dict()
        assert set(d) >= {
            "path", "present", "ok", "algorithm", "essenceBytes",
            "storedDigest", "computedDigest", "essenceElementCount", "error",
        }


def _build_multi_partition_mxf(runs, algorithm=_ALG_SHA1):
    """Build an MXF with one EssenceIntegrityPack per essence *run*.

    ``runs`` is a list of essence-chunk-lists; each run gets its own body
    partition worth of essence elements followed by its own correctly-scoped
    EssenceIntegrityPack, mirroring how real multi-partition MXF/IMF track
    files are written (SMPTE ST 429-6 -- one MIC per partition's essence).
    """
    out = bytearray()
    out += imf_mic._klv(imf_mic._partition_pack_key(0x02), b"\x00" * 8)
    element_number = 1
    for run in runs:
        hasher = imf_mic._ALG_HASHLIB[algorithm]()
        total = 0
        for chunk in run:
            hasher.update(chunk)
            total += len(chunk)
            out += imf_mic._klv(imf_mic._essence_element_key(element_number), chunk)
            element_number += 1
        pack_val = build_integrity_pack_value(algorithm, total, hasher.digest())
        out += imf_mic._klv(_ESSENCE_INTEGRITY_PACK_KEY, pack_val)
    out += imf_mic._klv(imf_mic._partition_pack_key(0x04), b"\x00" * 8)
    return bytes(out)


class TestMultiPartitionMic:
    """Regression: a per-partition EssenceIntegrityPack must be verified against
    only the essence elements written in its own partition run, not the whole
    file. Before the fix, verify_mxf_mic accumulated every essence element
    file-wide and compared the aggregate digest against only the *last*
    integrity pack found, silently discarding all earlier packs.
    """

    def _write(self, tmp_path, data, name="video.mxf"):
        p = tmp_path / name
        p.write_bytes(data)
        return p

    def test_two_valid_partitions_pass(self, tmp_path):
        data = _build_multi_partition_mxf([[b"frame0", b"frame1"], [b"frame2"]])
        p = self._write(tmp_path, data)
        r = verify_mxf_mic(p)
        assert r.present is True
        assert r.ok is True
        assert r.essence_element_count == 3
        assert r.essence_bytes == len(b"frame0") + len(b"frame1") + len(b"frame2")

    def test_second_partition_corruption_is_detected(self, tmp_path):
        # Before the fix: the whole-file digest would be recomputed over ALL
        # essence (both runs) and compared only to the second pack, which
        # happens to still make this fail -- so this alone wouldn't catch a
        # regression. The companion case below is the one that actually
        # distinguishes correct per-partition scoping from whole-file
        # aggregation.
        data = bytearray(_build_multi_partition_mxf([[b"frame0"], [b"frame1"]]))
        f = io.BytesIO(bytes(data))
        elements = [kl for kl in iter_klv(f) if is_essence_element(kl.key)]
        # Corrupt the second run's essence element only.
        data[elements[1].value_offset] ^= 0xFF
        p = self._write(tmp_path, bytes(data))
        r = verify_mxf_mic(p)
        assert r.ok is False

    def test_first_partition_corruption_is_detected(self, tmp_path):
        # This is the case that whole-file aggregation gets wrong: corrupting
        # the FIRST run's essence does not change the digest checked against
        # the LAST pack under the old (buggy) whole-file-vs-last-pack logic,
        # because that logic silently drops the first pack entirely -- it
        # only ever compares against the last one. Per-partition scoping must
        # catch this.
        data = bytearray(_build_multi_partition_mxf([[b"frame0"], [b"frame1"]]))
        f = io.BytesIO(bytes(data))
        elements = [kl for kl in iter_klv(f) if is_essence_element(kl.key)]
        data[elements[0].value_offset] ^= 0xFF
        p = self._write(tmp_path, bytes(data))
        r = verify_mxf_mic(p)
        assert r.ok is False
        assert "mismatch" in (r.error or "")


# ── batch rollup ─────────────────────────────────────────────────────────────

class TestVerifyMicForAssets:
    def test_all_pass(self, tmp_path):
        paths = []
        for i in range(3):
            p = tmp_path / f"v{i}.mxf"
            p.write_bytes(build_mxf_with_mic([b"x" * (i + 1)]))
            paths.append(str(p))
        roll = verify_mic_for_assets(paths)
        assert roll["checked"] == 3
        assert roll["passed"] == 3
        assert roll["failed"] == 0
        assert roll["overallStatus"] == "pass"

    def test_one_fail_makes_overall_fail(self, tmp_path):
        good = tmp_path / "good.mxf"
        good.write_bytes(build_mxf_with_mic([b"ok"]))
        bad = tmp_path / "bad.mxf"
        bad.write_bytes(build_mxf_with_mic([b"no"], corrupt_digest=True))
        roll = verify_mic_for_assets([str(good), str(bad)])
        assert roll["failed"] == 1
        assert roll["passed"] == 1
        assert roll["overallStatus"] == "fail"

    def test_no_mic_is_skip(self, tmp_path):
        p = tmp_path / "plain.mxf"
        p.write_bytes(build_mxf_with_mic([b"data"], omit_pack=True))
        roll = verify_mic_for_assets([str(p)])
        assert roll["checked"] == 0
        assert roll["absent"] == 1
        assert roll["overallStatus"] == "skip"

    def test_unreadable_counted(self, tmp_path):
        p = tmp_path / "junk.mxf"
        p.write_bytes(b"garbage not klv")
        roll = verify_mic_for_assets([str(p)])
        assert roll["unreadable"] == 1
        assert roll["overallStatus"] == "skip"

    def test_empty_list(self):
        roll = verify_mic_for_assets([])
        assert roll["overallStatus"] == "skip"
        assert roll["results"] == []
