<script setup lang="ts">
import termite from "../assets/termite.svg";

/**
 * The mark, which is the project's actual logo - not a redrawn approximation of it.
 *
 * It is a hand-drawn termite seen from above: orange body, dark green eyes, wire legs.
 * That hand is where the rest of the interface gets its edges from, so every panel in
 * the app is cut with the same slightly-wrong-on-purpose geometry the drawing has.
 *
 * It sits on the surface as the bare mark. No tile behind it, no circle, no glow - the
 * drawing has enough weight of its own, and a box around a logo is a component-kit
 * default rather than a decision.
 *
 * It inches: a millimetre forward and back over five and a half seconds, the way
 * something alive shifts while it works. Nothing depends on the animation and it stops
 * dead under prefers-reduced-motion.
 */
withDefaults(defineProps<{ size?: number; alt?: string }>(), { size: 34, alt: "" });
</script>

<template>
	<img
		class="mark"
		:src="termite"
		:alt="alt"
		:aria-hidden="alt ? undefined : 'true'"
		:style="{ height: `${size}px` }"
		draggable="false"
	/>
</template>

<style scoped>
.mark {
	display: block;
	width: auto;
	user-select: none;
	animation: inch 5.5s ease-in-out infinite;
}

@keyframes inch {
	0%,
	100% {
		transform: translateY(0);
	}
	45% {
		transform: translateY(-1.5px);
	}
}
</style>
