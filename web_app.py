"""
Angel backend (Railway): REST chat + location-aware system prompt.

The iPhone app sends JSON POST /api/chat with:
  { "message": str, "device": "ios", "location"?: { "latitude", "longitude", "place" } }

Legacy clients may use /api/message (same handler). Location may use "place_name" instead of "place".
"""

from __future__ import annotations

import json
import os
from typing import Any

from flask import Flask, request, jsonify

app = Flask(__name__)


def normalize_location(raw: Any) -> dict[str, float | str] | None:
    """Return {latitude, longitude, place} or None if invalid."""
    if not raw or not isinstance(raw, dict):
        return None
    lat, lon = raw.get("latitude"), raw.get("longitude")
    if lat is None or lon is None:
        return None
    try:
        lat_f = float(lat)
        lon_f = float(lon)
    except (TypeError, ValueError):
        return None
    place = raw.get("place") or raw.get("place_name") or ""
    return {
        "latitude": lat_f,
        "longitude": lon_f,
        "place": str(place) if place else "",
    }


def build_system_prompt(location: Any = None) -> str:
    """
    Core system instructions for Angel. When location is present, Tyler's GPS + place
    are injected so the model can reason about where Tyler is.
    """
    lines = [
        "You are Angel, Tyler's personal AI assistant on iPhone.",
        "Be concise, warm, and actionable. Align with Tyler's mission when context allows.",
    ]
    loc = normalize_location(location)
    if loc:
        place = loc["place"] or "an unspecified area"
        lines.append(
            f"Tyler's current approximate location: {place} "
            f"(GPS latitude {loc['latitude']:.6f}, longitude {loc['longitude']:.6f}). "
            "Use this for local context—weather, navigation, what's nearby, time zone hints—when relevant. "
            "If you are unsure, say so; do not invent specific venues from coordinates alone."
        )
    return "\n".join(lines)


def _generate_chat_reply(system_prompt: str, user_message: str, device: str) -> str:
    """Call OpenAI when configured; otherwise return a clear placeholder."""
    key = os.environ.get("OPENAI_API_KEY")
    if not key:
        return (
            "Angel backend: set OPENAI_API_KEY on Railway to enable LLM replies. "
            f"(Received message from {device!r}; system prompt includes location if sent.)"
        )
    try:
        from openai import OpenAI

        client = OpenAI(api_key=key)
        model = os.environ.get("OPENAI_MODEL", "gpt-4o-mini")
        r = client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_message},
            ],
        )
        return (r.choices[0].message.content or "").strip()
    except Exception as e:
        return f"[Angel LLM error: {e}]"


def _handle_chat_request():
    data = request.get_json(silent=True) or {}
    message = (data.get("message") or data.get("text") or "").strip()
    device = data.get("device", "")
    location = data.get("location")

    if not message:
        return jsonify({"error": "message required", "reply": ""}), 400

    system = build_system_prompt(location)
    reply = _generate_chat_reply(system, message, device)
    return jsonify(
        {
            "reply": reply,
            "response": reply,
            "text": reply,
        }
    )


@app.post("/api/chat")
def api_chat():
    return _handle_chat_request()


@app.post("/api/message")
def api_message():
    """Backward-compatible alias for older mobile builds."""
    return _handle_chat_request()


# --- Integrating location on your existing Railway app ---
#
# HTTP JSON (/api/vision):  loc = normalize_location(request.get_json(silent=True).get("location"))
# HTTP multipart (/api/voice):  loc = json.loads(request.form.get("location") or "null")
#                               loc = normalize_location(loc)
# Socket.IO "user_text" / "user_audio":  loc = normalize_location(data.get("location"))
#
# Pass `loc` (or the raw dict) into build_system_prompt(...) alongside the user message.


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=os.environ.get("FLASK_DEBUG") == "1")
