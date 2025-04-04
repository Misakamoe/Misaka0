FROM python:3.12-slim

WORKDIR /app

# 安装依赖
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 复制项目文件
COPY . .

# 确保目录存在
RUN mkdir -p logs config

# 如果配置文件不存在，使用示例文件
RUN if [ ! -f config/config.json ]; then cp config/config.json.example config/config.json; fi

# 设置时区
ENV TZ=Asia/Hong_Kong
RUN ln -snf /usr/share/zoneinfo/$TZ /etc/localtime && echo $TZ > /etc/timezone

# 运行机器人
CMD ["python", "bot.py"]