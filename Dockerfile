# FROM python:3.11-slim

# WORKDIR /app

# # Устанавливаем зависимости
# COPY client/requirements.txt ./client/requirements.txt
# COPY mcp_mongo_postgres/requirements.txt ./mcp_mongo_postgres/requirements.txt
# RUN pip install --no-cache-dir -r client/requirements.txt
# RUN pip install --no-cache-dir -r mcp_mongo_postgres/requirements.txt

# # Копируем весь проект
# COPY . .

# ENV PYTHONPATH=/app

# EXPOSE 3002 3003
