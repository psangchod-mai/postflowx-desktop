// IMF ASSETMAP / PKL / CPL parsing. Run: node tests-js/imfPackageIndex.test.mjs
import pkg from '../electron/imf/imf_package_index.js';
const { parseAssetMap, parsePKL, parseCPL } = pkg;

let passed = 0, failed = 0;
function ok(c, l) { if (c) { passed++; console.log('PASS -', l); } else { failed++; console.error('FAIL -', l); } }
function eq(got, want, l) { ok(got === want, `${l} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`); }
function near(got, want, l) { ok(Math.abs(got - want) < 1e-6, `${l} (got ${got}, want ${want})`); }

// ── ASSETMAP ──
const AM = `<AssetMap>
  <AssetList>
    <Asset><Id>urn:uuid:AAA-1</Id><ChunkList><Chunk><Path>CPL_x.xml</Path></Chunk></ChunkList></Asset>
    <Asset><Id>urn:uuid:BBB-2</Id><ChunkList><Chunk><Path>media/v.mxf</Path></Chunk></ChunkList></Asset>
  </AssetList>
</AssetMap>`;
const am = parseAssetMap(AM, '/imf/pkg');
eq(am.size, 2, 'ASSETMAP: 2 assets');
eq(am.get('aaa-1')?.relPath, 'CPL_x.xml', 'ASSETMAP: id normalised + relPath');
eq(am.get('bbb-2')?.absPath, '/imf/pkg/media/v.mxf', 'ASSETMAP: absPath resolved against folder');

// ── PKL ──
const PKL = `<PackingList>
  <AssetList>
    <Asset><Id>urn:uuid:FILE-1</Id><Type>application/mxf</Type><Size>1234</Size><OriginalFileName>video.mxf</OriginalFileName></Asset>
    <Asset><Id>urn:uuid:FILE-2</Id><Type>text/xml</Type><Size>99</Size><AnnotationText>cpl.xml</AnnotationText></Asset>
  </AssetList>
</PackingList>`;
const pkl = parsePKL(PKL);
eq(pkl.size, 2, 'PKL: 2 assets');
eq(pkl.get('file-1')?.size, 1234, 'PKL: size parsed');
eq(pkl.get('file-1')?.originalFileName, 'video.mxf', 'PKL: OriginalFileName');
eq(pkl.get('file-2')?.originalFileName, 'cpl.xml', 'PKL: falls back to AnnotationText');

// ── CPL ──
const CPL = `<CompositionPlaylist>
  <Id>urn:uuid:CPL-1</Id>
  <EditRate>24000 1001</EditRate>
  <SegmentList>
    <Segment>
      <SequenceList>
        <MainImageSequence><Id>urn:uuid:SEQ-IMG-1</Id><ResourceList>
          <TrackFileResource><Id>urn:uuid:R1</Id><IntrinsicDuration>240</IntrinsicDuration><EntryPoint>0</EntryPoint><SourceDuration>240</SourceDuration><TrackFileId>urn:uuid:F1</TrackFileId></TrackFileResource>
          <TrackFileResource><Id>urn:uuid:R2</Id><IntrinsicDuration>240</IntrinsicDuration><TrackFileId>urn:uuid:F2</TrackFileId></TrackFileResource>
        </ResourceList></MainImageSequence>
        <MainAudioSequence><Id>urn:uuid:SEQ-AUD-1</Id><ResourceList>
          <TrackFileResource><Id>urn:uuid:RA1</Id><IntrinsicDuration>240</IntrinsicDuration><SourceDuration>240</SourceDuration><TrackFileId>urn:uuid:FA</TrackFileId></TrackFileResource>
        </ResourceList></MainAudioSequence>
      </SequenceList>
    </Segment>
    <Segment>
      <SequenceList>
        <MainImageSequence><Id>urn:uuid:SEQ-IMG-2</Id><ResourceList>
          <TrackFileResource><Id>urn:uuid:R3</Id><IntrinsicDuration>120</IntrinsicDuration><SourceDuration>120</SourceDuration><RepeatCount>2</RepeatCount><TrackFileId>urn:uuid:F3</TrackFileId></TrackFileResource>
        </ResourceList></MainImageSequence>
      </SequenceList>
    </Segment>
  </SegmentList>
</CompositionPlaylist>`;
const cpl = parseCPL(CPL, 'fallback-id');
eq(cpl.id, 'cpl-1', 'CPL id normalised');
near(cpl.editRate, 24000 / 1001, 'CPL editRate 23.976');
eq(cpl.videoResources.length, 3, 'CPL: 3 image resources (audio excluded)');
// totalFrames = 240 (R1) + 240 (R2 default=intrinsic) + 120*2 (R3 RepeatCount) = 720
eq(cpl.totalFrames, 720, 'CPL totalFrames = Σ sourceDuration×repeat over image (incl. RepeatCount + SourceDuration-defaults-to-intrinsic)');
eq(cpl.segments.length, 2, 'CPL: 2 segments');

// Per-sequence resource scoping — the audio sequence must NOT include image resources
const seg0 = cpl.segments[0];
const audioSeq = seg0.sequences.find(s => s.seqType === 'MainAudioSequence');
eq(audioSeq?.resources.length, 1, 'audio sequence has ONLY its 1 resource (not the segment\'s image resources)');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
