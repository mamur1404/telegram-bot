module.exports = {
  apps: [
    {
      name: 'megawatt-bot',
      script: 'main.js',
      watch: true,
      env: {
        NODE_ENV: 'production'
      }
    }
  ]
};
