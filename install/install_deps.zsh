#!/bin/zsh


set -e

echo "Installing dependencies for ..."

if ! command -v node &> /dev/null; then
    echo "Node.js is not installed."
    exit 1
fi

echo "Node.js version: $(node --version)"
echo "npm version: $(npm --version)"

echo "\nInstalling npm packages..."
npm install

echo "\nTo run the app, use: npm start"