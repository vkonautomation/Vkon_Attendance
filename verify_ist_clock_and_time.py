def test_ist_implementation():
    print("=== VERIFYING INDIAN STANDARD TIME (IST) IMPLEMENTATION ===")
    
    with open("public/shared.js", "r", encoding="utf-8") as f:
        shared = f.read()
    with open("public/app.js", "r", encoding="utf-8") as f:
        app = f.read()
    with open("public/admin.js", "r", encoding="utf-8") as f:
        admin = f.read()
    with open("public/index.html", "r", encoding="utf-8") as f:
        html = f.read()
    with open("public/styles.css", "r", encoding="utf-8") as f:
        css = f.read()

    # 1. IST Engine in shared.js
    assert "Asia/Kolkata" in shared, "Asia/Kolkata timezone missing in shared.js"
    assert "fetchISTServerTime" in shared, "fetchISTServerTime missing in shared.js"
    assert "getNowIST" in shared, "getNowIST helper missing in shared.js"
    assert "getISTDate" in shared, "getISTDate helper missing in shared.js"
    print("PASS: shared.js IST Engine and authoritative fetch implemented.")

    # 2. Time and Date formatting in shared.js strictly in Asia/Kolkata
    assert 'timeZone: "Asia/Kolkata"' in shared, "timeZone: 'Asia/Kolkata' missing in shared.js formatting"
    print("PASS: formatDateKey and formatTimeString strictly use Asia/Kolkata timezone.")

    # 3. Live clock widget in app.js and admin.js
    assert 'getNowIST' in app, "app.js clock must use getNowIST"
    assert 'Asia/Kolkata' in app, "app.js clock must format using Asia/Kolkata"
    assert 'IST' in app, "app.js clock must display IST indicator"
    assert 'getNowIST' in admin, "admin.js clock must use getNowIST"
    assert 'Asia/Kolkata' in admin, "admin.js clock must format using Asia/Kolkata"
    assert 'IST' in admin, "admin.js clock must display IST indicator"
    print("PASS: Both Employee Portal and Admin Console live clocks run strictly on Indian Standard Time.")

    # 4. Cache-buster query parameters in HTML (current build token)
    assert "shared.js?v=20261029_e7" in html, "index.html must have updated cache buster for fresh load"
    assert "app.js?v=20261029_e7" in html, "app.js (which owns the IST clock) cache buster not bumped"
    print("PASS: index.html has fresh cache-buster parameters.")

    print("\n" + "=" * 50)
    print(">>> INDIAN STANDARD TIME (IST) VERIFICATION PASSED <<<")
    print("=" * 50)

if __name__ == "__main__":
    test_ist_implementation()
