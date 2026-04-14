# Use a base image with both Node.js and Python
FROM node:18

# Install Python and pip
RUN apt-get update && apt-get install -y python3 python3-pip python3-venv

# Set working directory
WORKDIR /app

# Create a virtual environment for Python packages
RUN python3 -m venv /app/venv

# Copy requirements.txt and install Python dependencies
COPY requirements.txt ./
RUN /app/venv/bin/pip install -r requirements.txt

# Copy package.json and install Node dependencies
COPY package.json ./
RUN npm install

# Copy the rest of the code
COPY . .

# Expose the port
EXPOSE 4173

# Start the app
CMD ["node", "server.js"]