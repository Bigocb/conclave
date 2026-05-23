#!/usr/bin/env python3
"""
Example Conclave CodeReviewer — Semgrep-based security scanner.

This script receives a task JSON on stdin and prints a review JSON on stdout.
It's designed to be used with fleet.yaml type=code reviewers:

  reviewers:
    - name: "Security Scanner"
      type: code
      command: "python3 examples/semgrep_reviewer.py"
      channels: [security-review]
"""

import json
import subprocess
import sys
import tempfile
import os


def main():
    # 1. Read task payload from stdin
    payload = json.loads(sys.stdin.read())

    task_id = payload.get("task_id", "unknown")
    output = payload.get("output", "")
    dimensions = payload.get("dimensions", ["correctness", "security", "style"])
    instructions = payload.get("instructions", "")
    skills = payload.get("skills", [])

    # 2. Write the code to a temp file for semgrep to scan
    findings = []
    with tempfile.NamedTemporaryFile(mode="w", suffix=".py", delete=False) as f:
        f.write(output)
        tmp_path = f.name

    try:
        # 3. Run semgrep (if installed) — fall back to basic pattern matching
        semgrep_found = os.system("which semgrep > /dev/null 2>&1") == 0

        if semgrep_found:
            result = subprocess.run(
                ["semgrep", "--config=auto", "--json", "--quiet", tmp_path],
                capture_output=True, text=True, timeout=30,
            )
            if result.returncode == 0 or result.returncode == 1:
                try:
                    report = json.loads(result.stdout)
                    for r in report.get("results", []):
                        findings.append({
                            "rule": r.get("check_id", "unknown"),
                            "message": r.get("extra", {}).get("message", ""),
                            "severity": r.get("extra", {}).get("severity", "WARNING"),
                            "line": r.get("start", {}).get("line", 0),
                        })
                except json.JSONDecodeError:
                    findings.append({"rule": "parse-error", "message": "Could not parse semgrep output"})
        else:
            # Fallback: basic pattern matching for common issues
            lines = output.split("\n")
            for i, line in enumerate(lines, 1):
                stripped = line.strip().lower()
                if "password" in stripped and "=" in stripped and "#" not in stripped.split("=")[0]:
                    findings.append({"rule": "hardcoded-password", "message": "Possible hardcoded password", "severity": "ERROR", "line": i})
                if "eval(" in stripped:
                    findings.append({"rule": "dangerous-eval", "message": "Use of eval() is dangerous", "severity": "ERROR", "line": i})
                if "sql" in stripped and "+" in stripped and "select" in stripped:
                    findings.append({"rule": "sql-injection-risk", "message": "Possible SQL injection via string concatenation", "severity": "ERROR", "line": i})
                if "import os" in stripped and "system(" in output.lower():
                    findings.append({"rule": "os-system-call", "message": "os.system() call detected — use subprocess", "severity": "WARNING", "line": i})

    finally:
        os.unlink(tmp_path)

    # 4. Build review output
    errors = [f for f in findings if f.get("severity") == "ERROR"]
    warnings = [f for f in findings if f.get("severity") == "WARNING"]

    # Score each dimension
    security = max(0, 10 - len(errors) * 3 - len(warnings))
    correctness = max(0, 10 - len(errors) * 2)
    style = max(5, 10 - len(warnings))

    scores = {}
    for dim in dimensions:
        if dim == "security":
            scores[dim] = security
        elif dim == "correctness":
            scores[dim] = correctness
        elif dim == "style":
            scores[dim] = style
        else:
            scores[dim] = 7  # neutral default

    overall = round(sum(scores.values()) / len(scores), 1) if scores else 5.0
    confidence = 1.0 if semgrep_found else 0.6  # lower confidence with pattern matching fallback

    # Build comment
    if errors:
        comment_lines = [f"⛔ {len(errors)} critical finding(s):"]
        for e in errors[:5]:  # max 5 in comment
            comment_lines.append(f"  • {e['rule']} (line {e.get('line', '?')}): {e['message']}")
    elif warnings:
        comment_lines = [f"⚠️ {len(warnings)} warning(s), no critical issues."]
        for w in warnings[:3]:
            comment_lines.append(f"  • {w['rule']} (line {w.get('line', '?')}): {w['message']}")
    else:
        comment_lines = ["✅ No security issues found by automated scan."]

    comment = "\n".join(comment_lines)[:1500]

    suggestions = list(set(f["rule"] for f in findings))[:5]

    # 5. Print JSON to stdout
    review = {
        "scores": scores,
        "weighted_overall": overall,
        "reviewer_confidence": confidence,
        "comment": comment,
        "suggestions": suggestions,
    }

    json.dump(review, sys.stdout, indent=2)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()