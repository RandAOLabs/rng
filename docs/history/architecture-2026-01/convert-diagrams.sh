#!/bin/bash

# PlantUML Diagram Converter Script
# Converts all .puml files to .png while preserving directory structure

# Disabled set -e to continue processing even when some files fail
# set -e

SOURCE_DIR="/diagrams/diagram-definitions"
OUTPUT_DIR="/diagrams/diagram-images"
PLANTUML_JAR="/usr/src/plantuml/plantuml.jar"

echo "Starting PlantUML diagram conversion..."
echo "Source directory: ${SOURCE_DIR}"
echo "Output directory: ${OUTPUT_DIR}"

# Check if source directory exists
if [ ! -d "${SOURCE_DIR}" ]; then
    echo "Error: Source directory ${SOURCE_DIR} does not exist!"
    exit 1
fi

# Create output directory if it doesn't exist
mkdir -p "${OUTPUT_DIR}"

# Function to convert a single PUML file
convert_puml() {
    local input_file="$1"
    local relative_path="${input_file#$SOURCE_DIR/}"
    local output_file="${OUTPUT_DIR}/${relative_path%.puml}.png"
    local output_dir="$(dirname "$output_file")"
    
    echo ""
    echo "================================================="
    echo "🔄 PROCESSING: $relative_path"
    echo "   Input:  $input_file"
    echo "   Output: $output_file"
    echo "================================================="
    
    # Skip style.puml as it's an include file, not a diagram
    if [[ "$(basename "$input_file")" == "style.puml" ]]; then
        echo "⏭️  SKIPPED: Style include file - $relative_path"
        return 0
    fi
    
    # Skip .gitkeep files
    if [[ "$(basename "$input_file")" == ".gitkeep" ]]; then
        echo "⏭️  SKIPPED: .gitkeep file - $relative_path"
        return 0
    fi
    
    # Check if input file exists and is readable
    if [ ! -r "$input_file" ]; then
        echo "❌ ERROR: Cannot read input file - $input_file"
        return 1
    fi
    
    # Create output directory if it doesn't exist
    echo "📁 Creating output directory: $output_dir"
    mkdir -p "$output_dir"
    
    echo "🚀 Converting with PlantUML..."
    echo "   Command: java -jar ${PLANTUML_JAR} -tpng -o $output_dir $input_file"
    
    # Convert PUML to PNG using PlantUML
    # Capture both stdout and stderr for better error reporting
    local plantuml_output
    if plantuml_output=$(java -jar "${PLANTUML_JAR}" -tpng -o "$output_dir" "$input_file" 2>&1); then
        echo "📤 PlantUML output:"
        echo "$plantuml_output"
        
        # Check if the PNG was created in the output directory
        if [ -f "$output_file" ]; then
            echo "✅ SUCCESS: Generated $(basename "$output_file")"
            return 0
        else
            echo "⚠️  WARNING: PlantUML completed but PNG not found at expected location"
            echo "   Expected: $output_file"
            echo "   Checking alternative locations..."
            find "$output_dir" -name "*.png" -exec echo "   Found: {}" \;
            return 1
        fi
    else
        echo "❌ COMPILATION FAILED: $relative_path does not compile"
        echo "🔍 PlantUML Error Output:"
        echo "$plantuml_output"
        echo "   This file contains syntax errors or missing dependencies"
        return 1
    fi
}

# Main conversion function
echo ""
echo "========================================="
echo "🔍 SCANNING FOR .puml FILES..."
echo "   Source: ${SOURCE_DIR}"
echo "========================================="

file_count=0
success_count=0
failed_files=()

# Find all PUML files first
all_files=($(find "${SOURCE_DIR}" -name "*.puml" -type f))

echo "📊 Found ${#all_files[@]} .puml files to process"
echo ""

# Process each file with detailed logging
for file in "${all_files[@]}"; do
    ((file_count++))
    echo "📝 FILE $file_count of ${#all_files[@]}: $(basename "$file")"
    echo "   Full path: $file"
    
    if convert_puml "$file"; then
        ((success_count++))
        echo "   ✅ RESULT: Success"
    else
        failed_files+=("$file")
        echo "   ❌ RESULT: Failed"
    fi
    echo ""
done

echo ""
echo "========================================="
echo "📊 FINAL CONVERSION SUMMARY"
echo "========================================="
echo "📁 Source Directory: ${SOURCE_DIR}"
echo "📁 Output Directory: ${OUTPUT_DIR}"
echo ""
echo "📈 Statistics:"
echo "   📄 Total .puml files found: $file_count"
echo "   ✅ Successfully converted: $success_count"
echo "   ❌ Failed to convert: $((file_count - success_count))"
echo ""

# Show details about failed files
if [ ${#failed_files[@]} -gt 0 ]; then
    echo "❌ FAILED FILES ($(( file_count - success_count ))):"
    for failed_file in "${failed_files[@]}"; do
        relative_failed="${failed_file#$SOURCE_DIR/}"
        echo "   • $relative_failed"
    done
    echo ""
fi

# List the generated structure
if [ $success_count -gt 0 ]; then
    echo "✅ GENERATED FILES:"
    if command -v tree >/dev/null 2>&1; then
        tree "${OUTPUT_DIR}" 2>/dev/null || true
    else
        echo "   Directory structure:"
        find "${OUTPUT_DIR}" -type f -name "*.png" | sort | while read file; do
            echo "   📄 ${file#$OUTPUT_DIR/}"
        done
    fi
else
    echo "😞 No PNG files were generated"
fi

echo ""
echo "========================================="
if [ $success_count -gt 0 ]; then
    echo "🎉 PlantUML conversion completed successfully!"
    echo "   Check the '$(basename "$OUTPUT_DIR")' directory for your PNG diagrams."
else
    echo "💥 PlantUML conversion failed!"
    echo "   No files were successfully converted."
fi
echo "========================================="

# Exit with error if no files were converted
if [ $success_count -eq 0 ]; then
    exit 1
fi