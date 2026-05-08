from agent_vm_observability.model import NormalizedTrace
from agent_vm_observability.sentry_sink import USAGE_SPAN_OP, _gen_ai_attributes, _transaction_op


def test_usage_trace_matches_sentry_ai_agents_insights_fields() -> None:
    measurements = {
        "input_tokens": 100,
        "output_tokens": 20,
        "total_tokens": 120,
        "cost_usd": 0.00123,
    }
    trace = NormalizedTrace(
        agent="codex",
        kind="codex.sse_event",
        model="gpt-5.5",
        provider="openai",
        measurements=measurements,
    )

    attrs = _gen_ai_attributes(trace, measurements)

    assert _transaction_op(trace) == USAGE_SPAN_OP
    assert attrs["gen_ai.operation.name"] == "responses"
    assert attrs["gen_ai.request.model"] == "gpt-5.5"
    assert attrs["gen_ai.usage.total_tokens"] == 120
    assert attrs["gen_ai.usage.total_cost"] == 0.00123
