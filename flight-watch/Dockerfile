FROM python:3.13-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
EXPOSE 8000
VOLUME /app/data
# Set FLIGHT_WATCH_TOKEN (and optionally TELEGRAM_* / DISCORD_WEBHOOK_URL) at run time.
CMD ["python", "server.py", "--host", "0.0.0.0", "--scan-every", "6"]
