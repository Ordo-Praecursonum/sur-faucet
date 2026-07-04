module.exports = {
  apps: [
    {
      name: 'sur-faucet',
      script: 'npm',
      args: 'start',
      cwd: '/home/el/app/sur-faucet',
      interpreter: 'none',
      env: {
        NODE_ENV: 'production',
      },
      watch: false,
      autorestart: true,
      restart_delay: 3000,
      max_restarts: 10,
    },
  ],
};
