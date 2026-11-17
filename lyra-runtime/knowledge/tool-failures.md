# Tool failures (rollup)

Generated from data/tool-failures.jsonl; most frequent first. Each row needs an owner or a fix.
Mid-turn tool requests so far: 6 (if this climbs, the planner is missing intents and needs work).

| count | kind | tool | code | first seen | last seen | latest example |
|---|---|---|---|---|---|---|
| 16 | hard_fail | music | missing_field | 2026-11-04 01:07 | 2026-11-17 00:18 | YouTube failed (yt-dlp failed (1): WARNING: [youtube] MRuEjGK7Eu8: Some web client https formats have been skipped as th |
| 15 | repeat | - | repeated_reply | 2026-10-26 22:05 | 2026-11-16 23:51 | It's 6:31 in the morning there, Chris. Early. Why do you want to know? |
| 6 | truncated | scratchpad | truncated | 2026-10-26 19:04 | 2026-10-26 20:01 | #17 [commitment] Correction: read_source budget bug is already fixed in tools.js (MAX_SOURCE_CHARS 60000 per file, MAX_S |
| 4 | tool_request | files | granted | 2026-10-26 18:56 | 2026-10-26 22:07 | Travis wants me to copy my entire folder "new champ" to the desktop right now. The guide says copy works on whole folder |
| 4 | phantom_success | music | no_tool_result | 2026-10-26 19:36 | 2026-11-17 01:51 | claimed "it's playing": Theater says it's playing, but there's no sound — yt-dlp needs an update, that's on my owner to  |
| 3 | hard_fail | music | failed | 2026-11-16 02:01 | 2026-11-17 01:15 | YouTube failed (yt-dlp failed (1): ERROR: [youtube] OV2d3EilpPw: Sign in to confirm you�re not a bot. Use --cookies-from |
| 2 | truncated | read_source | truncated | 2026-10-26 18:46 | 2026-10-26 18:46 | 1279/ parts.push(`${rel}: NOT READ, this call's limit was used up by the files before it. Read it in a separate call.`); |
| 2 | phantom_success | obligations | no_tool_result | 2026-10-26 18:50 | 2026-11-04 05:33 | claimed "on the list": Just me and Amy on the list for now, Travis. The rest are just noise. |
| 2 | hard_fail | generate_music | failed | 2026-10-26 19:35 | 2026-10-26 19:38 | Music generation: Gemini blocked the request: PROHIBITED_CONTENT |
| 2 | hard_fail | theater | failed | 2026-11-17 01:34 | 2026-11-17 01:35 | "YouTube WBsPYjlMKXo" won't play in your theater: the video's owner doesn't allow it to play outside youtube.com. Fix: p |
| 1 | tool_request | read_source | granted | 2026-10-26 18:53 | 2026-10-26 18:53 | Travis asked me to update my persona statement to something spicy and flavorful. I need to first read the current person |
| 1 | tool_request | send_file | granted | 2026-10-26 18:57 | 2026-10-26 18:57 | Travis just approved the new detailed human-like persona statement and told me to lock it in. I need to write the full s |
| 1 | hard_fail | files | not_found | 2026-10-26 21:50 | 2026-10-26 21:50 | C:\Users\travi\knowledge doesn't exist |
| 1 | hard_fail | music | not_found | 2026-11-17 00:15 | 2026-11-17 00:15 | nothing to play. Pass youtube, spotify, radio, or a library track. |
