import NotFound from '../not-found';

export const metadata = { title: 'Not found', robots: { index: false } };

export default function Missing() {
  return <NotFound />;
}
