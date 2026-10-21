# The OpenMTM2 room server in a container (docs/DAEMON.md). From the project folder:
#   docker build -f deploy/Dockerfile -t openmtm2d .
#   docker run -d --name openmtm2d -p 47660:47660 -v openmtm2:/data openmtm2d
# Settings come from OPENMTM2_* variables, or a file: -v ./server.json:/etc/openmtm2/server.json -e OPENMTM2_CONFIG=/etc/openmtm2/server.json
FROM node:22-alpine
WORKDIR /app
COPY package.json LICENSE README.md ./
COPY bin ./bin
COPY lib ./lib
COPY dplay ./dplay
COPY protocol ./protocol
COPY rooms ./rooms
RUN mkdir -p /data && chown node:node /data
ENV OPENMTM2_HOST=0.0.0.0 OPENMTM2_STATE_DIR=/data
VOLUME /data
EXPOSE 47660
# With OPENMTM2_GATEWAY=true (docs/GATEWAY.md) also 47624/udp, 47624/tcp, 2300-2350/tcp and 2350-2400/udp;
# --network host is simpler, as DirectPlay messages carry addresses.
USER node
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:47660/healthz || exit 1
CMD ["node", "bin/openmtm2d.mjs"]
