// Integration tests read the same env the server does. Unit tests need none.
import { config } from "dotenv";

config({ path: ".env.local", quiet: true });
