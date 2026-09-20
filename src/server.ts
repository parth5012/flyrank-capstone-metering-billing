// Process entrypoint - scaffold only.
import 'dotenv/config';
import { createApp } from './app';

const PORT = process.env.PORT ?? 3000;
const app = createApp();

if (require.main === module) {
  app.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`metering scaffold listening on ${PORT}`);
  });
}

export default app;
