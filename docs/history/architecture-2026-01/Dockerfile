FROM eclipse-temurin:11-jre

# Install required packages
RUN apt-get update && apt-get install -y \
    wget \
    graphviz \
    dos2unix \
    && rm -rf /var/lib/apt/lists/*

# Create working directory
WORKDIR /usr/src/plantuml

# Download PlantUML jar
RUN wget -O plantuml.jar https://github.com/plantuml/plantuml/releases/download/v1.2023.12/plantuml-1.2023.12.jar

# Create the conversion script
COPY convert-diagrams.sh /usr/src/plantuml/
RUN dos2unix /usr/src/plantuml/convert-diagrams.sh && \
    chmod +x convert-diagrams.sh

# Set working directory for diagram processing
WORKDIR /diagrams

# Default command
CMD ["/usr/src/plantuml/convert-diagrams.sh"]