FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY server/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY server/app.py VERSION ./
EXPOSE 8080
# yt-dlp si aggiorna a ogni avvio: i siti cambiano spesso
CMD ["sh", "-c", "pip install -U --no-cache-dir yt-dlp >/dev/null 2>&1; python app.py"]
