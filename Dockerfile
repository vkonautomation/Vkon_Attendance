FROM python:3.11-slim

WORKDIR /app

# Install dependencies first for better layer caching.
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Application code + existing static frontend are served by the same container.
COPY . ./

# Persist the SQLite database in a dedicated directory (mount a volume here).
ENV VKON_DB_PATH=/app/data/vkon.db \
    VKON_ENV=prod \
    PYTHONUNBUFFERED=1

RUN mkdir -p /app/data

EXPOSE 8000

# Uvicorn serves both the /api backend and the static site (same origin).
CMD ["uvicorn", "server.main:app", "--host", "0.0.0.0", "--port", "8000"]
