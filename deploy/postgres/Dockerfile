FROM postgres:17.7-alpine
COPY initialize.sh /docker-entrypoint-initdb.d/initialize.sh
RUN chmod 755 /docker-entrypoint-initdb.d/initialize.sh
