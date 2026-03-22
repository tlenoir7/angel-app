"""
Angel backend (Railway): REST chat + location-aware system prompt.

The iPhone app sends JSON POST /api/chat with:
  { "message": str, "device": "ios", "location"?: { "latitude", "longitude", "place" } }

Legacy clients may use /api/message (same handler). Location may use "place_name" instead of "place".
"""

from __future__ import annotations

import base64
import json
import os
from io import BytesIO
from typing import Any

from flask import Flask, request, jsonify

try:
    from pypdf import PdfReader
except ImportError:
    PdfReader = None  # type: ignore

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


def _extract_text_from_upload(file_name: str, raw: bytes) -> str:
    """Best-effort text extraction for PDF and plain-text-like files."""
    name = (file_name or "").lower()
    if name.endswith(".pdf"):
        if PdfReader is None:
            return (
                "[PDF attached but pypdf is not installed on the server. "
                "Add pypdf to requirements.txt and redeploy.]"
            )
        try:
            reader = PdfReader(BytesIO(raw))
            parts: list[str] = []
            for page in reader.pages:
                parts.append(page.extract_text() or "")
            text = "\n".join(parts).strip()
            if not text:
                return (
                    "[PDF opened but no text was extracted — it may be scanned images only. "
                    "Try OCR or a text-based PDF.]"
                )
            return text
        except Exception as e:
            return f"[Could not read PDF: {e}]"
    # Plain text / code / csv
    try:
        return raw.decode("utf-8", errors="replace")
    except Exception:
        return "[Binary file — decode as UTF-8 failed.]"


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


@app.post("/api/files/read")
def api_files_read():
    """
    iPhone sends JSON:
      { "file_content": base64, "file_name": str, "context": str, "device": "ios", "location"?: {...} }
    """
    data = request.get_json(silent=True) or {}
    context = (data.get("context") or "").strip()
    file_name = data.get("file_name") or "attachment"
    device = data.get("device", "")
    location = data.get("location")
    b64 = data.get("file_content")
    if not b64 or not isinstance(b64, str):
        return jsonify({"error": "file_content required (base64 string)", "reply": ""}), 400
    try:
        raw = base64.b64decode(b64, validate=False)
    except Exception as e:
        return jsonify({"error": f"invalid base64: {e}", "reply": ""}), 400
    if len(raw) == 0:
        return jsonify({"error": "decoded file is empty", "reply": ""}), 400

    extracted = _extract_text_from_upload(file_name, raw)
    # Cap size sent to the model (very large PDFs / logs)
    max_chars = int(os.environ.get("FILE_EXTRACT_MAX_CHARS", "120000"))
    if len(extracted) > max_chars:
        extracted = extracted[:max_chars] + "\n\n[…truncated for length]"

    system = build_system_prompt(location)
    user_message = (
        f"Tyler attached file {file_name!r}.\n"
        f"Tyler's instructions: {context or '(none)'}\n\n"
        f"--- File content (extracted) ---\n{extracted}\n--- End ---\n\n"
        "Summarize and answer based on this content and Tyler's instructions."
    )
    reply = _generate_chat_reply(system, user_message, device)
    return jsonify({"reply": reply, "response": reply, "text": reply})


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
