import os

print("=== VERIFYING NEW USER REQUIREMENTS ===")

# 1. Verify index.html login page
with open("public/index.html", "r", encoding="utf-8") as f:
    index_html = f.read()

# A. No login credential tabs
assert 'class="auth-tabs"' not in index_html, "FAIL: auth-tabs found in index.html!"
print("PASS: auth-tabs removed from index.html")

# B. Only one employee mentioned for simulation (Mukesh)
assert 'Chiranth (EMP003)' not in index_html and 'Priya (EMP002)' not in index_html, "FAIL: Multi-employee chips (Chiranth/Priya) still present in login page!"
assert 'Mukesh Sharma (EMP001)' in index_html, "FAIL: Mukesh Sharma (EMP001) simulation chip missing from login page!"
print("PASS: Only one employee (Mukesh Sharma) is mentioned on login page for simulation")

# 2. Verify shared.js
with open("public/shared.js", "r", encoding="utf-8") as f:
    shared_js = f.read()

assert '[`EMP001_${year}-10-08`]' not in shared_js, "FAIL: EMP001_10-08 should not be in initialRecords (Mukesh must start unpunched)"
assert '[`EMP002_${year}-10-08`]' in shared_js, "FAIL: EMP002_10-08 should be seeded for Priya to provide admin data"
print("PASS: shared.js starts EMP001 unpunched and seeds EMP002 for admin view")

# 3. Verify app.js strict photo validation
with open("public/app.js", "r", encoding="utf-8") as f:
    app_js = f.read()

assert 'if (!capturedLiveSelfie || !isLivePhotoVerified' in app_js, "FAIL: app.js missing strict capturedLiveSelfie and isLivePhotoVerified validation!"
assert 'modalLiveAvatar.src = dataUrl' in app_js, "FAIL: modalLiveAvatar preview not set upon photo capture in app.js!"
print("PASS: app.js strictly enforces photo capture before marking attendance")

print("\n>>> ALL NEW REQUIREMENTS VERIFIED SUCCESSFULLY! <<<")
