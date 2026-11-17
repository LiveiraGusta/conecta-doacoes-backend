// Carrega .env.test antes de qualquer import de src/core/env (que só preenche o que faltar).
import dotenv from 'dotenv';

dotenv.config({ path: '.env.test', override: true, quiet: true });
