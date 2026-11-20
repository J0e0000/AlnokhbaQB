import { redirect } from 'next/navigation';

// The app lives under /exams (and friends); `/` forwards there so the
// preview entry point, browser back and refresh all behave as expected.
export default function Home() {
  redirect('/exams');
}
