from types import SimpleNamespace

from postflowx_companion import proxy_service


def test_preview_h264_args_uses_libx264_when_available(monkeypatch):
    monkeypatch.setattr(
        proxy_service.subprocess,
        "run",
        lambda *args, **kwargs: SimpleNamespace(
            stdout=" V....D libx264              libx264 H.264 encoder\n",
            stderr="",
        ),
    )

    args = proxy_service._preview_h264_args("/tmp/ffmpeg")

    assert args == ["-c:v", "libx264", "-preset", "ultrafast", "-crf", "23"]


def test_preview_h264_args_uses_videotoolbox_for_bundled_build(monkeypatch):
    monkeypatch.setattr(
        proxy_service.subprocess,
        "run",
        lambda *args, **kwargs: SimpleNamespace(
            stdout=" V....D h264_videotoolbox    VideoToolbox H.264 Encoder\n",
            stderr="",
        ),
    )

    args = proxy_service._preview_h264_args("/tmp/ffmpeg")

    assert args == [
        "-c:v", "h264_videotoolbox",
        "-b:v", "5M",
        "-allow_sw", "1",
        "-realtime", "0",
    ]


def test_preview_h264_args_has_generic_last_resort(monkeypatch):
    monkeypatch.setattr(
        proxy_service.subprocess,
        "run",
        lambda *args, **kwargs: SimpleNamespace(stdout="", stderr=""),
    )

    assert proxy_service._preview_h264_args("/tmp/ffmpeg") == ["-c:v", "h264"]
