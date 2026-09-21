"""Gap 1: run_resolve_job_async should auto-launch Resolve on demand when it
isn't running, and respect an explicit opt-out (manual/never) by handing off."""
import os
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from postflowx_companion.engines import resolve_engine as RE  # noqa: E402
from postflowx_companion.service_state import create_session, get_session  # noqa: E402


def _run(job_extra, *, start_result, monkeypatch_attrs):
    tmp = tempfile.mkdtemp(prefix="pfx_glt_")
    fake_resolve = os.path.join(tmp, "Resolve")
    open(fake_resolve, "w").close()  # effective_path must exist

    calls = {"start": 0, "start_kwargs": None}

    def fake_start(path, **kwargs):
        calls["start"] += 1
        calls["start_kwargs"] = kwargs
        return dict(start_result)

    RE._resolve_is_running = lambda *a, **k: False          # type: ignore
    RE.create_manual_handoff = lambda job, out: os.path.join(out, "manual_handoff")  # type: ignore
    RE.start_resolve_engine = fake_start                    # type: ignore

    job = {"jobId": "gaptest1", "type": "metadata_probe", "outputDir": tmp}
    job.update(job_extra)
    sid = "sess_" + "gaptest"
    create_session(sid, {"kind": "resolve_job", "done": False})
    RE.run_resolve_job_async(sid, job, fake_resolve, timeout_seconds=1, debug=False)
    return calls, get_session(sid)


def test_opt_out_policy_never_does_not_launch():
    calls, sess = _run({"launchPolicy": "never"}, start_result={"connected": False},
                       monkeypatch_attrs=None)
    assert calls["start"] == 0, "must NOT auto-launch when policy is 'never'"
    assert sess.get("errorCode") == "RESOLVE_NOT_RUNNING"


def test_on_demand_attempts_background_launch():
    # Launch attempted but API doesn't come up -> graceful handoff, but proves
    # the auto-launch path ran (the old code never called start_resolve_engine).
    calls, sess = _run(
        {"launchPolicy": "on_demand", "runMode": "background"},
        start_result={"connected": False, "code": "RESOLVE_HEADLESS_UNAVAILABLE",
                      "message": "API not up"},
        monkeypatch_attrs=None,
    )
    assert calls["start"] == 1, "on_demand policy must attempt a background launch"
    assert calls["start_kwargs"]["launch_policy"] == "on_demand"
    assert calls["start_kwargs"]["run_mode"] == "background"
    assert sess.get("errorCode") == "RESOLVE_HEADLESS_UNAVAILABLE"


def test_default_policy_auto_launches():
    # No policy on the job at all -> defaults to on_demand (product default).
    calls, sess = _run({}, start_result={"connected": False, "code": "X", "message": "m"},
                       monkeypatch_attrs=None)
    assert calls["start"] == 1, "missing policy should default to auto-launch"
    assert calls["start_kwargs"]["launch_policy"] == "on_demand"
