import json
from pathlib import Path

from agent_vm_observability.config import RuntimeConfig
from agent_vm_observability.ingest import AgentIngestor
from agent_vm_observability.sentry_sink import SentrySink
from agent_vm_observability.state import empty_state


def make_config(tmp_path: Path, pi_root: Path, pi_sessions_glob: str = "") -> RuntimeConfig:
    return RuntimeConfig(
        config_path=tmp_path / "env",
        legacy_config_path=tmp_path / "legacy-env",
        state_path=tmp_path / "state.json",
        memory_db_path=tmp_path / "memory.db",
        codex_logs_db=tmp_path / "missing-codex-logs.sqlite",
        codex_state_db=tmp_path / "missing-codex-state.sqlite",
        claude_projects_glob=str(tmp_path / "missing-claude" / "*.jsonl"),
        claude_mem_db=tmp_path / "missing-claude-mem.db",
        pi_suggester_glob=str(pi_root),
        sentry_dsn=None,
        sentry_org="example-org",
        sentry_project="agent-vm-usage",
        sentry_project_id=None,
        include_text=False,
        traces_sample_rate=1.0,
        max_batch=10,
        poll_seconds=15,
        record_memory=True,
        pi_sessions_glob=pi_sessions_glob,
    )


def test_process_once_exports_pi_suggester_events(tmp_path: Path) -> None:
    pi_root = tmp_path / ".pi" / "suggester"
    log_path = pi_root / "logs" / "events.ndjson"
    log_path.parent.mkdir(parents=True)
    log_path.write_text(
        json.dumps(
            {
                "at": "2026-05-03T06:12:05.162Z",
                "level": "info",
                "message": "suggestion.generated",
                "meta": {
                    "turnId": "a11350ae",
                    "strategy": "compact",
                    "inputTokens": 4635,
                    "outputTokens": 128,
                    "cacheReadTokens": 0,
                    "cacheWriteTokens": 0,
                    "totalTokens": 4763,
                    "cost": 0.027015,
                    "preview": "can you make it use oauth instead?",
                },
            }
        )
        + "\n"
    )

    config = make_config(tmp_path, pi_root)
    sink = SentrySink(config, dry_run=True)
    state = empty_state()
    counts = AgentIngestor(config, sink).process_once(state, max_batch=10)

    assert counts["pi_records"] == 1
    assert state["pi_files"][str(log_path)]["offset"] == log_path.stat().st_size
    assert [trace.title for trace in sink.captured] == ["pi.suggestion.generated"]
    assert sink.captured[0].measurements["cost_usd"] == 0.027015


def test_process_once_exports_pi_session_usage_and_tools(tmp_path: Path) -> None:
    session_dir = tmp_path / ".pi" / "agent" / "sessions" / "--Users-sahanp-4._personal_projects-example--"
    session_path = session_dir / "2026-05-09T09-11-15-239Z_019e0c01-5827-708b-8b51-a9a0d1ca89e8.jsonl"
    session_path.parent.mkdir(parents=True)
    records = [
        {
            "type": "session",
            "version": 3,
            "id": "019e0c01-5827-708b-8b51-a9a0d1ca89e8",
            "timestamp": "2026-05-09T09:11:15.239Z",
            "cwd": str(tmp_path / "example"),
        },
        {
            "type": "model_change",
            "id": "model-1",
            "timestamp": "2026-05-09T09:11:17.579Z",
            "provider": "openai-codex",
            "modelId": "gpt-5.5",
        },
        {
            "type": "message",
            "id": "assistant-1",
            "timestamp": "2026-05-09T09:14:17.204Z",
            "message": {
                "role": "assistant",
                "provider": "openai-codex",
                "model": "gpt-5.5",
                "usage": {
                    "input": 1000,
                    "output": 200,
                    "cacheRead": 3000,
                    "cacheWrite": 0,
                    "totalTokens": 4200,
                    "cost": {"input": 0.005, "output": 0.006, "cacheRead": 0.0015, "cacheWrite": 0, "total": 0.0125},
                },
                "content": [
                    {"type": "text", "text": "Done"},
                    {"type": "toolCall", "id": "call-1", "name": "bash", "arguments": {"command": "echo hi"}},
                ],
            },
        },
        {
            "type": "message",
            "id": "tool-result-1",
            "timestamp": "2026-05-09T09:14:18.204Z",
            "message": {
                "role": "toolResult",
                "toolCallId": "call-1",
                "toolName": "bash",
                "isError": False,
                "content": [{"type": "text", "text": "hi"}],
            },
        },
    ]
    session_path.write_text("".join(json.dumps(record) + "\n" for record in records))

    config = make_config(tmp_path, tmp_path / "missing-suggester", str(session_path))
    sink = SentrySink(config, dry_run=True)
    state = empty_state()
    counts = AgentIngestor(config, sink).process_once(state, max_batch=10)

    assert counts["pi_session_records"] == 4
    assert state["pi_session_files"][str(session_path)]["offset"] == session_path.stat().st_size
    assert [trace.title for trace in sink.captured] == [
        "pi.session_start",
        "pi.model_change",
        "pi.assistant_turn",
        "pi.tool_call",
        "pi.tool_result",
    ]
    assistant = sink.captured[2]
    assert assistant.measurements["input_tokens"] == 1000
    assert assistant.measurements["cache_read_input_tokens"] == 3000
    assert assistant.measurements["total_tokens"] == 4200
    assert assistant.measurements["cost_usd"] == 0.0125
    assert sink.captured[3].tags["tool_name"] == "bash"


def test_existing_pi_session_files_are_tailed_on_upgrade(tmp_path: Path) -> None:
    session_root = tmp_path / ".pi" / "agent" / "sessions" / "--Users-sahanp-4._personal_projects-example--"
    session_root.mkdir(parents=True)
    paths = [session_root / f"2026-05-09T09-11-1{i}-000Z_session-{i}.jsonl" for i in range(2)]
    for path in paths:
        path.write_text(
            json.dumps(
                {
                    "type": "message",
                    "id": "assistant-1",
                    "timestamp": "2026-05-09T09:14:17.204Z",
                    "message": {
                        "role": "assistant",
                        "provider": "openai-codex",
                        "model": "gpt-5.5",
                        "usage": {"input": 1, "output": 1, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 2, "cost": {"total": 0.1}},
                        "content": [{"type": "text", "text": "old"}],
                    },
                }
            )
            + "\n"
        )

    config = make_config(tmp_path, tmp_path / "missing-suggester", str(session_root / "*.jsonl"))
    sink = SentrySink(config, dry_run=True)
    state = {**empty_state(), "initialized_at": 1}
    counts = AgentIngestor(config, sink).process_once(state, max_batch=10)

    assert counts["pi_session_records"] == 0
    assert sink.captured == []
    for path in paths:
        assert state["pi_session_files"][str(path)]["offset"] == path.stat().st_size
