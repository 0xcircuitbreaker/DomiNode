"""Semantic Kernel adapter: registration and invocation through a real Kernel."""

from __future__ import annotations

import asyncio
import json
from unittest.mock import MagicMock

from semantic_kernel import Kernel
from semantic_kernel.functions import KernelArguments, KernelPlugin

from dominusnode_semantic_kernel import TOOL_NAMES, DominusNodePlugin, DominusNodeToolkit

FAKE_KEY = "dn_live_" + "k" * 40


def _plugin():
    sdk = MagicMock()
    return DominusNodePlugin(toolkit=DominusNodeToolkit(api_key=FAKE_KEY, client=sdk)), sdk


def test_plugin_registers_exactly_19_functions():
    p, _ = _plugin()
    kp = KernelPlugin.from_object("dominusnode", p)
    assert sorted(kp.functions) == sorted(TOOL_NAMES)


def test_metadata_has_no_key_parameter():
    p, _ = _plugin()
    kp = KernelPlugin.from_object("dominusnode", p)
    for fn in kp.functions.values():
        names = [m.name for m in fn.metadata.parameters]
        assert "api_key" not in names
        assert FAKE_KEY not in json.dumps([m.schema_data for m in fn.metadata.parameters], default=str)
        assert fn.description


def test_kernel_invoke_dispatches_to_sdk():
    p, sdk = _plugin()
    sdk.wallet.get_crypto_status.return_value = {"status": "paid"}
    kernel = Kernel()
    kernel.add_plugin(p, plugin_name="dominusnode")
    res = asyncio.run(kernel.invoke(plugin_name="dominusnode", function_name="check_payment",
                                    arguments=KernelArguments(invoice_id="123e4567-e89b-42d3-a456-426614174000")))
    assert json.loads(str(res)) == {"status": "paid"}
    sdk.wallet.get_crypto_status.assert_called_once_with("123e4567-e89b-42d3-a456-426614174000")


def test_kernel_invoke_fetch_and_scrub():
    p, sdk = _plugin()
    sdk.proxy.fetch.side_effect = Exception(f"tunnel refused for {FAKE_KEY}")
    kernel = Kernel()
    kernel.add_plugin(p, plugin_name="dominusnode")
    res = asyncio.run(kernel.invoke(plugin_name="dominusnode", function_name="fetch",
                                    arguments=KernelArguments(url="https://example.com", country="DE")))
    out = str(res)
    assert FAKE_KEY not in out and "[REDACTED]" in out
    assert sdk.proxy.fetch.call_args.kwargs["country"] == "DE"
