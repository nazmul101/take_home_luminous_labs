import { Router, type Request, type Response } from 'express';
import { authorization } from '../../../middlewares/auth.middle';
import { wrap } from '../../../middlewares/wrap.middle';
import { RequestValidationError } from '../../../errors/validation.error';
import { UnauthorizedError } from '../../../errors/unauthorized.error';
import { sendSuccess } from '../../../utils/response';
import { orderParamsSchema, orderQuerySchema } from '../validators/orders.validator';
import { decodeCursor } from '../utils/cursor';
import { getOrderHistory } from '../services/orders.service';

const router = Router();

router.get(
  '/users/:id/orders',
  wrap(authorization(), async (req: Request, res: Response) => {

    if (!req.user) throw new UnauthorizedError();

    const params = orderParamsSchema.safeParse(req.params);
    if (!params.success) throw new RequestValidationError(params.error.issues);

    const query = orderQuerySchema.safeParse(req.query);
    if (!query.success) throw new RequestValidationError(query.error.issues);

    const page = await getOrderHistory({
      caller: req.user,
      targetUserId: params.data.id,
      limit: query.data.limit,
      after: query.data.cursor ? decodeCursor(query.data.cursor) : undefined,
    });

    sendSuccess(res, {
      message: page.orders.length ? 'Orders retrieved' : 'No orders found for this user',
      data: page.orders,
      meta: { next_cursor: page.nextCursor, limit: query.data.limit },
    });
  }),
);

export default router;
