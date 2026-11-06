### dominusnode_report_session
Report a burned or bad exit for one of your relay sessions so the network can rotate it.

args:
- session_id (string, required): Session UUID from active_sessions.
- reason (string, required): Why the exit is bad. one of: blocked, captcha, rate_limited, slow, bad_content, other.
usage:
~~~json
{
    "thoughts": [
        "I should use dominusnode_report_session."
    ],
    "headline": "Report a burned or bad exit for one of your relay sessions so the network can ro",
    "tool_name": "dominusnode_report_session",
    "tool_args": {
        "session_id": "<session_id>",
        "reason": "blocked"
    }
}
~~~
