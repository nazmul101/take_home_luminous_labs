import { Router, type Request, type Response } from 'express';
import { wrap } from '../../../middlewares/wrap.middle';
import { RequestValidationError } from '../../../errors/validation.error';
import { sendSuccess } from '../../../utils/response';
import { loginSchema } from '../validators/auth.validator';
import { login } from '../services/auth.service';

const router = Router();

// One login route, not one per role. The role comes from the user's row and goes into
// the token; a separate admin route would do identical work and would imply an admin
// could not authenticate through the ordinary one.
//
// This endpoint exists so the Postman collection is self-contained - the brief asks who
// may read an order history, not how credentials are exchanged.
router.post(
  '/login',
  wrap(async (req: Request, res: Response) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) throw new RequestValidationError(parsed.error.issues);

    const result = await login(parsed.data.email, parsed.data.password);

    sendSuccess(res, { message: 'Login successful', data: result });
  }),
);

export default router;
