FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY server/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY server/*.py VERSION ./
EXPOSE 8080
# yt-dlp si aggiorna a ogni avvio: i siti cambiano spesso. [default] porta yt-dlp-ejs (la versione giusta per
# quel yt-dlp) e [deno] il motore JavaScript che YouTube ormai richiede; il plugin chiede i PO Token al servizio pot
CMD ["sh", "-c", "pip install -U --no-cache-dir 'yt-dlp[default,deno]' bgutil-ytdlp-pot-provider >/dev/null 2>&1; python app.py"]
