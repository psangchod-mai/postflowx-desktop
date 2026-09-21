"""Permanent regression tests for the XXE guard (safe_xml).

safe_xml is the single sanctioned XML entrypoint for untrusted IMF/DoVi/FCPXML/ADM
input; it must reject DOCTYPE/ENTITY declarations (blocking external-entity XXE and
billion-laughs expansion) while parsing legitimate XML. Previously only verified via a
one-off inline run — locked here so the guard can't silently regress.
"""
import pytest

from postflowx_companion import safe_xml


def test_legit_xml_parses():
    root = safe_xml.fromstring('<AssetMap xmlns="urn:smpte"><AssetList/></AssetMap>')
    assert root.tag.endswith("AssetMap")


def test_external_entity_xxe_rejected():
    xxe = ('<?xml version="1.0"?><!DOCTYPE r [<!ENTITY x SYSTEM "file:///etc/passwd">]>'
           '<r>&x;</r>')
    with pytest.raises(safe_xml.UnsafeXMLError):
        safe_xml.fromstring(xxe)


def test_billion_laughs_rejected():
    lol = ('<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY a "x"><!ENTITY b "&a;&a;">]>'
           '<lolz>&b;</lolz>')
    with pytest.raises(safe_xml.UnsafeXMLError):
        safe_xml.fromstring(lol)


def test_doctype_without_entity_still_rejected():
    with pytest.raises(safe_xml.UnsafeXMLError):
        safe_xml.fromstring('<!DOCTYPE html><html></html>')


def test_doctype_in_comment_is_not_a_false_positive():
    root = safe_xml.fromstring('<!-- mentions <!DOCTYPE in a comment --><r>ok</r>')
    assert root.tag == "r"


def test_read_xml_and_parse_path(tmp_path):
    p = tmp_path / "cpl.xml"
    p.write_text('<CompositionPlaylist><Id>urn:uuid:1</Id></CompositionPlaylist>', encoding="utf-8")
    text, root = safe_xml.read_xml(p)
    assert "CompositionPlaylist" in text and root.tag == "CompositionPlaylist"
    tree = safe_xml.parse_path(p)
    assert tree.getroot().tag == "CompositionPlaylist"


def test_read_xml_rejects_xxe_file(tmp_path):
    p = tmp_path / "evil.xml"
    p.write_text('<!DOCTYPE r [<!ENTITY x SYSTEM "file:///etc/hosts">]><r>&x;</r>', encoding="utf-8")
    with pytest.raises(safe_xml.UnsafeXMLError):
        safe_xml.read_xml(p)
