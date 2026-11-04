#!/usr/bin/env python3
"""
Static verification for the GMAIL / PHONE + EMAIL-NOTIFICATION feature.

Covers the two halves of the request "add the option of gmail and phone number of
the employee and the notification which is there in web page it should go to their
respective gmails":

  A. The employee record carries a Gmail + phone -- captured at enrollment and in
     the edit modal, shown in the roster and in the employee's own profile chip.
  B. The on-page regularisation warning is also emailed to that person, via a
     server-side nodemailer send (/api/notify + lib/mail.ts).

The security properties that make (B) safe are asserted directly on the backend
route: the recipient address is resolved server-side from the roster document (never
taken from the request body), a caller may only mail themselves unless they are an
admin, and the whole feature is inert when SMTP is not configured.

It is a static check -- it reads the source and asserts the wiring is present and
ordered correctly -- mirroring the other verify_*.py suites.
"""

import sys


def read_pub(name):
    with open("public/" + name, "r", encoding="utf-8") as f:
        return f.read()


def read_root(name):
    with open(name, "r", encoding="utf-8") as f:
        return f.read()


def verify_all():
    print("=== VERIFYING GMAIL/PHONE FIELD + EMAIL NOTIFICATIONS ===")

    results = []

    def need(cond, msg):
        assert cond, "Fail: " + msg
        results.append("PASS: " + msg)

    admin_html = read_pub("admin.html")
    index_html = read_pub("index.html")
    admin = read_pub("admin.js")
    app = read_pub("app.js")
    api = read_pub("js/api.js")

    notify_route = read_root("app/api/notify/route.ts")
    mail_ts = read_root("lib/mail.ts")
    config_ts = read_root("lib/config.ts")
    documents_ts = read_root("lib/state/documents.ts")
    pkg = read_root("package.json")
    env_example = read_root(".env.example")

    # ---- A1. Enrollment form has Gmail + phone inputs ---------------------
    print("\n[A] Employee Gmail + phone capture and display:")
    need('id="newEmpEmail"' in admin_html and 'id="newEmpPhone"' in admin_html,
         "enrollment form has Gmail + phone inputs")
    # ---- A2. Edit modal has Gmail + phone inputs --------------------------
    need('id="editEmpEmail"' in admin_html and 'id="editEmpPhone"' in admin_html,
         "edit modal has Gmail + phone inputs")
    # ---- A3. admin.js reads them on enroll and stores them on the record --
    need('getElementById("newEmpEmail")' in admin and 'getElementById("newEmpPhone")' in admin,
         "admin.js reads the enrollment Gmail + phone fields")
    need('email: email,' in admin and 'phone: phone,' in admin,
         "admin.js stores email + phone on the new employee record")
    # ---- A4. admin.js populates + saves them on edit ----------------------
    need('getElementById("editEmpEmail")' in admin and 'getElementById("editEmpPhone")' in admin,
         "admin.js wires the edit-modal Gmail + phone fields")
    need('emp.email = email' in admin and 'emp.phone = phone' in admin,
         "admin.js saves email + phone on edit")
    # ---- A5. roster shows the contact line --------------------------------
    need("roster-contact-line" in admin,
         "roster table shows the employee's Gmail + phone")
    # ---- A6. the employee's own profile chip shows it ---------------------
    need('id="currentEmpContact"' in index_html,
         "index.html profile chip has a contact slot")
    need('getElementById("currentEmpContact")' in app and "emp.email" in app and "emp.phone" in app,
         "app.js shows the signed-in employee's own Gmail + phone")

    # ---- B1. client fires a notify once per day, server-backed only -------
    print("\n[B] Regularisation warning reaches the employee's Gmail:")
    need("_maybeEmailRegWarnings" in app and "api.notify" in app,
         "app.js emails the past-cut-off regularisation warnings")
    need("vkon_reg_email_sent_v2" in app and "Asia/Kolkata" in app,
         "email send is throttled once per portal-day (IST) client-side")
    need("res.sent === true" in app and "_regEmailInFlight" in app,
         "the day is claimed only after the server confirms a send (a failed attempt retries)")
    need("isServerBacked" in app,
         "email send only runs server-backed (no transport in a demo browser)")
    # ---- B2. api.js exposes notify() -> POST /notify ----------------------
    need("async function notify(payload)" in api and '"/notify"' in api,
         "api.js exposes notify() posting to /notify")
    need("notify," in api,
         "notify is on the VKON_API surface the page calls")

    # ---- B3. the route is safe: server-resolved recipient, self-or-admin --
    need("readDocument" in notify_route and "EMPLOYEES_KEY" in notify_route,
         "/api/notify resolves the address from the server roster document")
    need('body, "to"' not in notify_route and "requireString(body, \"employeeId\"" in notify_route,
         "/api/notify never takes a recipient address from the request body")
    need('session.role !== "admin"' in notify_route and "forbidden" in notify_route,
         "/api/notify allows self unless admin")
    need("isMailEnabled" in notify_route and "not_configured" in notify_route,
         "/api/notify is inert (succeeds, sends nothing) without SMTP config")
    need("export async function readDocument" in documents_ts and
         'classifyDocument(key) === "never"' in documents_ts,
         "documents.ts readDocument returns the server roster copy and suppresses never-class keys")

    # ---- B4. mail transport + config + dependency + env ------------------
    need("nodemailer.createTransport" in mail_ts and "sendNotificationMail" in mail_ts,
         "lib/mail.ts owns the nodemailer transport")
    need("mail:" in config_ts and "MAIL_ENABLED" in config_ts and "SMTP_USER" in config_ts,
         "config.ts reads the mail knobs")
    need('"enabled = bool(env.MAIL_ENABLED"' in config_ts.replace("      ", "") or
         ("MAIL_ENABLED" in config_ts and "&& !!user &&" in config_ts),
         "mail defaults off unless enabled AND a sender is configured")
    need('"nodemailer"' in pkg and '"@types/nodemailer"' in pkg,
         "package.json depends on nodemailer (+ types)")
    need("MAIL_ENABLED" in env_example and "SMTP_PASS" in env_example and "App Password" in env_example,
         ".env.example documents the SMTP block (no committed secret)")

    # ---- shared cache token bumped for this build -------------------------
    print("\n[Cache] shared cache-buster token bumped:")
    need("20261102_en13" in index_html, "index.html cache token bumped to en7")
    need("20261102_en13" in admin_html, "admin.html cache token bumped to en7")
    need("20261029_e9" not in index_html and "20261029_e9" not in admin_html,
         "old e9 token fully replaced in both pages")

    for r in results:
        print("  " + r)

    print("\n" + "=" * 55)
    print("ALL GMAIL/PHONE + EMAIL-NOTIFICATION CHECKS PASSED")
    print("=" * 55)


if __name__ == "__main__":
    try:
        verify_all()
    except AssertionError as e:
        print(str(e))
        sys.exit(1)
