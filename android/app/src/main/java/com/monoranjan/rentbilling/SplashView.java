package com.monoranjan.rentbilling;

import android.animation.ValueAnimator;
import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BlurMaskFilter;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.PorterDuff;
import android.graphics.PorterDuffColorFilter;
import android.graphics.RadialGradient;
import android.graphics.Shader;
import android.graphics.drawable.Drawable;
import android.view.View;
import android.view.animation.OvershootInterpolator;
import androidx.core.content.ContextCompat;
import java.util.Random;

// A flat, single-tone background made the house-in-a-tag mark hard to
// pick out against it, and a plain AnimatedVectorDrawable pop can't do a
// particle burst or a glowing pulse (no particle system, no blur). This
// draws the whole thing by hand instead: a radial gradient (not flat) so
// there's depth, the mark rendered much larger than the launcher icon's
// safe-zone-constrained size, a soft neon glow halo that breathes behind
// it, and a burst of small sparks drifting outward — all driven from one
// ValueAnimator so they stay in sync.
public class SplashView extends View {
    private static final long DURATION_MS = 1700;
    private static final int PARTICLE_COUNT = 26;
    private static final int NEON_COLOR = Color.parseColor("#4DE8FF");
    private static final int BASE_BLUE = Color.parseColor("#0075BE");
    private static final int BRIGHT_BLUE = Color.parseColor("#2CA8E8");
    private static final int DEEP_BLUE = Color.parseColor("#043A5E");

    public interface OnFinishedListener {
        void onFinished();
    }

    private final Paint backgroundPaint = new Paint();
    private final Paint glowPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint markPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint particlePaint = new Paint(Paint.ANTI_ALIAS_FLAG);

    private Bitmap markBitmap;
    private float markSize;
    private float centerX;
    private float centerY;
    private float progress; // 0..1 over the whole animation
    private ValueAnimator animator;
    private OnFinishedListener finishedListener;

    private final Particle[] particles = new Particle[PARTICLE_COUNT];
    private final Random random = new Random();

    private static final class Particle {
        float angle;
        float speed; // fraction of travel radius per unit progress
        float size;
        float startFrac; // where in 0..1 this particle begins moving
    }

    public SplashView(Context context) {
        super(context);
        // BlurMaskFilter (used for the neon glow) only renders with a
        // software layer — hardware acceleration silently ignores it.
        setLayerType(View.LAYER_TYPE_SOFTWARE, null);
        particlePaint.setStyle(Paint.Style.FILL);
        for (int i = 0; i < PARTICLE_COUNT; i++) {
            Particle p = new Particle();
            p.angle = (float) (random.nextDouble() * Math.PI * 2);
            p.speed = 0.75f + random.nextFloat() * 0.55f;
            p.size = 3f + random.nextFloat() * 5f;
            p.startFrac = random.nextFloat() * 0.25f;
            particles[i] = p;
        }
    }

    public void setOnFinishedListener(OnFinishedListener listener) {
        this.finishedListener = listener;
    }

    @Override
    protected void onSizeChanged(int w, int h, int oldw, int oldh) {
        super.onSizeChanged(w, h, oldw, oldh);
        centerX = w / 2f;
        centerY = h / 2f;

        backgroundPaint.setShader(new RadialGradient(
                centerX, centerY, Math.max(w, h) * 0.75f,
                new int[] { BRIGHT_BLUE, BASE_BLUE, DEEP_BLUE },
                new float[] { 0f, 0.55f, 1f },
                Shader.TileMode.CLAMP));

        // Bold and easy to identify: about 62% of the shorter screen
        // dimension, well beyond the launcher icon's safe-zone sizing —
        // there's no mask clipping to worry about on a splash screen.
        markSize = Math.min(w, h) * 0.62f;
        markBitmap = renderMarkBitmap((int) markSize);
    }

    private Bitmap renderMarkBitmap(int size) {
        Drawable drawable = ContextCompat.getDrawable(getContext(), R.drawable.ic_splash_mark);
        Bitmap bitmap = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(bitmap);
        if (drawable != null) {
            drawable.setBounds(0, 0, size, size);
            drawable.draw(canvas);
        }
        return bitmap;
    }

    public void start() {
        animator = ValueAnimator.ofFloat(0f, 1f);
        animator.setDuration(DURATION_MS);
        animator.addUpdateListener(a -> {
            progress = (float) a.getAnimatedValue();
            invalidate();
        });
        animator.addListener(new android.animation.AnimatorListenerAdapter() {
            @Override
            public void onAnimationEnd(android.animation.Animator animation) {
                if (finishedListener != null) {
                    finishedListener.onFinished();
                }
            }
        });
        animator.start();
    }

    public void stop() {
        if (animator != null) {
            animator.cancel();
        }
    }

    @Override
    protected void onDraw(Canvas canvas) {
        canvas.drawRect(0, 0, getWidth(), getHeight(), backgroundPaint);
        if (markBitmap == null) {
            return;
        }

        drawParticles(canvas);
        drawGlow(canvas);
        drawMark(canvas);
    }

    private void drawParticles(Canvas canvas) {
        // Particles travel from just outside the mark's edge outward,
        // fading as they go — a quick outward spark burst rather than a
        // sustained emitter, since the whole splash is only ~1.7s.
        float startRadius = markSize * 0.42f;
        float maxRadius = Math.max(getWidth(), getHeight()) * 0.5f;
        for (Particle p : particles) {
            float local = (progress - p.startFrac) / (1f - p.startFrac);
            if (local <= 0f || local >= 1f) {
                continue;
            }
            float eased = 1f - (1f - local) * (1f - local); // ease-out
            float radius = startRadius + (maxRadius - startRadius) * eased * p.speed;
            float alpha = (1f - eased) * 220f;
            float x = centerX + (float) Math.cos(p.angle) * radius;
            float y = centerY + (float) Math.sin(p.angle) * radius;

            particlePaint.setColor(NEON_COLOR);
            particlePaint.setAlpha(Math.max(0, (int) alpha));
            particlePaint.setMaskFilter(new BlurMaskFilter(p.size * 0.9f, BlurMaskFilter.Blur.NORMAL));
            canvas.drawCircle(x, y, p.size * (1f - eased * 0.3f), particlePaint);
        }
    }

    private void drawGlow(Canvas canvas) {
        // A continuous breathing pulse (about two full cycles across the
        // animation) rather than a one-shot fade, so the glow feels alive
        // for the whole splash instead of just flashing once.
        double cycle = progress * Math.PI * 2 * 2.2;
        float pulse = 0.5f + 0.5f * (float) Math.sin(cycle);
        float blurRadius = 18f + pulse * 22f;
        int alpha = 90 + (int) (pulse * 90);

        glowPaint.setColorFilter(new PorterDuffColorFilter(NEON_COLOR, PorterDuff.Mode.SRC_ATOP));
        glowPaint.setAlpha(Math.min(255, alpha));
        glowPaint.setMaskFilter(new BlurMaskFilter(blurRadius, BlurMaskFilter.Blur.NORMAL));

        float glowScale = 1.08f;
        float half = markSize / 2f;
        canvas.save();
        canvas.translate(centerX - half * glowScale, centerY - half * glowScale);
        canvas.scale(glowScale, glowScale);
        canvas.drawBitmap(markBitmap, 0, 0, glowPaint);
        canvas.restore();
    }

    private void drawMark(Canvas canvas) {
        // A quick overshoot pop for roughly the first third of the
        // animation, then it settles at full size for the rest.
        float popT = Math.min(1f, progress / 0.4f);
        float scale = new OvershootInterpolator(2.6f).getInterpolation(popT);

        float half = markSize / 2f;
        canvas.save();
        canvas.translate(centerX, centerY);
        canvas.scale(scale, scale);
        canvas.translate(-half, -half);
        markPaint.setAlpha(255);
        canvas.drawBitmap(markBitmap, 0, 0, markPaint);
        canvas.restore();
    }
}
