FROM node:24-slim AS frontend-build

WORKDIR /frontend

COPY frontend/package*.json ./
COPY frontend/index.html frontend/vite.config.js ./
COPY frontend/public ./public
COPY frontend/src ./src

RUN npm ci
RUN npm run build


FROM ghcr.io/astral-sh/uv:0.12.18@sha256:3adc3706091ce7c2fe595e669628caedd6d951551b92b258b7e7dbe06d9440bc AS uv

FROM python:3.11-slim

WORKDIR /app

# Force Python to flush stdout/stderr immediately so logs appear in
# `docker compose logs -f` without buffering delay.
ENV PYTHONUNBUFFERED=1

# Keep the application environment isolated from the base image and prevent
# uv from silently downloading a different Python runtime during the build.
ENV UV_PYTHON_DOWNLOADS=0 \
    UV_PROJECT_ENVIRONMENT=/opt/venv \
    PATH="/opt/venv/bin:$PATH"

# Install the verified, reproducibly pinned uv binary.
COPY --from=uv /uv /usr/local/bin/uv

# Install system libraries required by pycti (python-magic needs libmagic1)
RUN apt-get update && apt-get install -y --no-install-recommends \
        libmagic1 \
    && rm -rf /var/lib/apt/lists/*

# Copy dependency files first for layer caching
COPY pyproject.toml uv.lock ./

# Install exactly the lockfile versions into the runtime virtual environment.
RUN uv sync --frozen --no-dev --no-install-project --no-cache

# Copy application code
COPY app.py ./
COPY tests ./tests
COPY sources ./sources
COPY core ./core
COPY cases ./cases
COPY utils ./utils
COPY db ./db
COPY integrations ./integrations
COPY scripts ./scripts
COPY config ./config
COPY --from=frontend-build /frontend/dist ./frontend/dist

RUN mkdir -p /app/data


EXPOSE 8000

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
