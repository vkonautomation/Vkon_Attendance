# VKON Attendance -- public front-end only.
#
# This image ships NOTHING but the browser files. Repository history, backend
# source, secrets, tests and runtime data are excluded twice over: by the
# explicit COPY list below and by .dockerignore. The docroot is /srv/public and
# nothing is ever written inside it, so there is no path where a database or a
# captured photo can be fetched over HTTP.
FROM python:3.12-slim

# Never let pip/python drop .pyc or buffer logs in the image.
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /srv

# Dedicated public folder: only HTML, CSS, JS and images are copied in.
COPY index.html admin.html styles.css /srv/public/
COPY app.js admin.js shared.js /srv/public/
COPY js/ /srv/public/js/
COPY assets/ /srv/public/assets/

# Data lives outside the served docroot; mount a volume here.
RUN mkdir -p /var/lib/vkon \
 && find /srv/public -type d -exec chmod 0755 {} \; \
 && find /srv/public -type f -exec chmod 0644 {} \; \
 && useradd --system --uid 10001 --no-create-home --shell /usr/sbin/nologin vkon \
 && chown -R vkon:vkon /srv /var/lib/vkon

USER vkon

EXPOSE 8000

# --directory pins the docroot to /srv/public, so /data, /server and /.git
# cannot be resolved no matter what is requested.
CMD ["python", "-m", "http.server", "8000", "--bind", "0.0.0.0", "--directory", "/srv/public"]
