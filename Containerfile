FROM docker.io/library/node:22-slim

RUN useradd --system --no-create-home stash

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --ignore-scripts

COPY stash.js index.html encrypted.html ./

RUN mkdir -p /var/cache/stash && chown stash /var/cache/stash

USER stash
EXPOSE 8080

CMD ["node", "stash.js"]
