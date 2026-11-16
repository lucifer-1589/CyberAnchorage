FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
WORKDIR /app

RUN useradd --create-home --uid 10001 anchorage

# Dependency layer first (cached unless pyproject changes)
COPY pyproject.toml ./
RUN mkdir anchorage && touch anchorage/__init__.py && pip install . && rm -rf anchorage

COPY . .
RUN pip install --no-deps --force-reinstall . \
    && mkdir -p /data/demo-cti && chown -R anchorage /data
USER anchorage
EXPOSE 8077
