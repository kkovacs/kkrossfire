#!/usr/bin/env python3
# Serves a page with a strict CSP (script-src 'self', no 'unsafe-eval') to test run_js.
from http.server import HTTPServer, BaseHTTPRequestHandler

HTML = b"""<!doctype html><html><head><title>csp-test</title></head><body>
<button id="b">click me</button>
<div id="out">before</div>
<script src="/app.js"></script>
</body></html>"""

JS = b"document.getElementById('b').addEventListener('click', function(){ document.getElementById('out').innerText = 'clicked'; });"

class H(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == '/app.js':
            body, ct = JS, 'application/javascript'
        else:
            body, ct = HTML, 'text/html'
        self.send_response(200)
        self.send_header('Content-Type', ct)
        self.send_header('Content-Security-Policy', "script-src 'self'")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass

HTTPServer(('127.0.0.1', 8099), H).serve_forever()
