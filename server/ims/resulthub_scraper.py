#!/usr/bin/env python3
"""
resulthub_scraper.py - Fetch student academic history from ResultHub.

Usage:
    python resulthub_scraper.py <roll_number> [year]

Example:
    python resulthub_scraper.py 2024UME4113 2028
"""

import sys
import json
import re
import urllib.request
import urllib.error


def fetch_profile(roll_number, year=None):
    if not roll_number:
        return {"success": False, "history": {}}

    if not year:
        if roll_number.startswith("202"):
            try:
                year = int(roll_number[:4]) + 4
            except ValueError:
                year = 2028
        else:
            year = 2028

    url = f"https://www.resulthubdtu.com/NSUT/StudentProfile/{year}/{roll_number}"
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
    }

    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            html = resp.read().decode("utf-8", errors="ignore")
    except Exception as e:
        return {"success": False, "history": {}, "error": str(e)}

    if not html or len(html) < 500:
        return {"success": False, "history": {}}

    seed = html

    history = {}
    cgpa_match = re.search(r"Cumulative CGPA[\s\n]*([\d\.]+)", seed) or re.search(r"CGPA[:\s]+([\d]+\.[\d]+)", seed)
    history["cgpa"] = cgpa_match.group(1) if cgpa_match else "--"

    uni_match = re.search(r"University Rank[\s\n]*#?(\d+)", seed) or re.search(r"University[\s\n]+Rank[:\s]*#?(\d+)", seed)
    history["universityRank"] = f"#{uni_match.group(1)}" if uni_match else "--"

    dept_match = re.search(r"Dept\.?\s*Rank\s*#?(\d+)", seed, re.IGNORECASE)
    history["deptRank"] = f"#{dept_match.group(1)}" if dept_match else "--"

    credits_match = re.search(r"Credits Completed[\s\n]*(\d+)", seed)
    history["credits"] = credits_match.group(1) if credits_match else "--"

    history["sgpa"] = []
    lines = seed.split("\n")
    for i, line in enumerate(lines):
        line = line.strip()
        sem_match = re.match(r"^Semester\s+(I|II|III|IV|V|VI|VII|VIII|\d+)$", line)
        if sem_match:
            for j in range(i + 1, min(i + 6, len(lines))):
                next_line = lines[j].strip()
                if re.match(r"^\d+\s*cr$", next_line, re.IGNORECASE):
                    for k in range(j + 1, min(j + 3, len(lines))):
                        sgpa_line = lines[k].strip()
                        sgpa_match = re.match(r"^(\d+\.\d+)$", sgpa_line)
                        if sgpa_match:
                            history["sgpa"].append(float(sgpa_match.group(1)))
                            break
                    break

    if not history["sgpa"]:
        numbers = re.findall(r"\b\d+\.\d+\b", seed)
        if numbers:
            unique = sorted(set(float(n) for n in numbers), reverse=True)
            history["sgpa"] = [n for n in unique if 0 < n <= 10][:8]

    if not history["sgpa"]:
        history["sgpa"] = []

    history["major"] = "B.Tech"
    branch_match = re.search(r"Branch[:\s]+([^,<>\n]+)", seed, re.IGNORECASE)
    if branch_match:
        branch = branch_match.group(1).strip()
        if "Mechanical" in branch:
            history["major"] = "Mechanical Engineering"
        elif "Computer" in branch or "COE" in branch or "CSE" in branch or "CSA" in branch or "AI" in branch or "ML" in branch or "Data Science" in branch or "Software" in branch:
            history["major"] = "Computer Science"
        elif "Electronics" in branch or "ECE" in branch or "EEE" in branch or "E CE" in branch:
            history["major"] = "Electronics & Comm."
        elif "Civil" in branch:
            history["major"] = "Civil Engineering"
        elif "IT" in branch or "Information Technology" in branch:
            history["major"] = "Information Technology"
        else:
            history["major"] = branch

    history["name"] = "Student"
    title_match = re.search(r"<title>([^<]+?)\(", seed)
    if title_match:
        history["name"] = title_match.group(1).strip()

    history["url"] = url
    return {"success": True, "history": history}


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"success": False, "history": {}}))
        sys.exit(1)

    roll_number = sys.argv[1]
    year = sys.argv[2] if len(sys.argv) > 2 else None

    result = fetch_profile(roll_number, year)
    print(json.dumps(result))


if __name__ == "__main__":
    main()
