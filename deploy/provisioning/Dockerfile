FROM python:3.13.8-alpine3.22
WORKDIR /app
COPY provisioning/provision.py /app/provision.py
COPY keycloak/realm.json /app/realm.json
CMD ["python", "/app/provision.py"]
