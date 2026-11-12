"""2.1 additions: masked exit class, node class fields, cursor paging."""
from __future__ import annotations

from typing import Any

import pytest

from conftest import Recorder
from dominusnode.errors import ValidationError
from dominusnode.proxy_fetch import build_proxy_username


def test_class_masked_username() -> None:
    assert build_proxy_username(ip_class="masked") == "class-masked"
    assert build_proxy_username(country="us", ip_class="masked") == "country-US-class-masked"
    with pytest.raises(ValidationError):
        build_proxy_username(ip_class="isp")


def test_nodes_iterate_follows_next_cursor(rec: Recorder, client: Any) -> None:
    rec.add(200, {"nodes": [{"id": "a", "verifiedClass": "masked", "tierWeight": 0.25}], "nextCursor": "abc="})
    rec.add(200, {"nodes": [{"id": "b"}], "nextCursor": None})
    out = list(client.nodes.iterate(limit=1))
    assert [n["id"] for n in out] == ["a", "b"]
    assert out[0]["tierWeight"] == 0.25
    assert "cursor=abc%3D" in str(rec.last.url)


def test_payouts_iterate_follows_next_cursor(rec: Recorder, client: Any) -> None:
    rec.add(200, {"payouts": [{"id": "1"}], "nextCursor": "MjAy"})
    rec.add(200, {"payouts": [], "nextCursor": None})
    assert len(list(client.payouts.iterate())) == 1
    assert "cursor=MjAy" in str(rec.last.url)


def test_bad_cursor_rejected(client: Any) -> None:
    with pytest.raises(ValidationError):
        client.nodes.list(cursor="bad cursor")
