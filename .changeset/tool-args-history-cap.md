---
"browserhive": patch
---

Tool-call history stores at most 64 KiB of each call's arguments (D-47). Before, every call's arguments were stored whole, so an agent looping on oversized calls (up to 4 MiB each, including calls rejected with `INVALID_ARGUMENTS`) could grow the database by gigabytes and slow the session timeline.

- Larger arguments are stored as `{"_truncated": true, "bytes": <full size>, "preview": "<start of the arguments>"}`, which `GET …/tool-calls?expand=detail` and `GET …/tool-calls/{event_id}` return in `args_json`. The dashboard shows them with a note giving the full size, and the start as text.
- Redaction still runs first: the cut only ever sees redacted arguments.
- Tool results keep their 16 KiB cap. Rows recorded before this release are left as they are until retention removes them.
