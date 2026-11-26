import type { Metadata } from "next";
import { UseDemo } from "../../components/use-demo";
import styles from "./use-demo.module.css";

export const metadata: Metadata = {
  title: "Use it · RNG Labs",
  description: "Play three RNG demos, inspect the draw, and open the implementation.",
};

export default function UsePage() {
  return <UseDemo className={styles.page} />;
}
