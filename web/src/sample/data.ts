/**
 * Built-in sample material. These "documents" were written for Graphu, so they are safe to
 * ship; they are not course documents. Each proposal cites a page and an exact quote, and the
 * sample backend runs the same grounding check the server will run before showing any of it.
 */

/** Mirrors `Candidate` in backend/extraction.py, plus an optional node symbol. */
export type Candidate = {
  title: string
  target: string
  relation: string
  page: number
  quote: string
  symbol?: string
}

export type SampleDoc = {
  id: string
  name: string
  context: string
  created_at: string
  pages: string[]
  items: Candidate[]
  /** Review decision applied when the sample is first loaded. */
  status: 'approved' | 'pending'
}

const concept = (title: string, symbol: string, page: number, quote: string): Candidate =>
  ({ title, target: '', relation: '', page, quote, symbol })
const link = (title: string, target: string, page: number, quote: string, relation = 'relies on'): Candidate =>
  ({ title, target, relation, page, quote })

const review: SampleDoc = {
  id: 'sample-calc-review',
  name: 'Calc I review notes.pdf',
  context: 'review notes from the first three weeks',
  created_at: '2026-10-05T17:10:00Z',
  status: 'approved',
  pages: [
    'The derivative of f at x measures the instantaneous rate of change of f. It is defined as the limit of the difference quotient (f(x+h) − f(x)) / h as h approaches 0. To find where a function is largest or smallest, set the derivative equal to zero and check the critical points. This procedure is called optimization.',
    'A Riemann sum approximates the area under a curve by adding the areas of thin rectangles. The definite integral is the limit of Riemann sums as the rectangles become infinitely thin.',
    'The fundamental theorem of calculus states that the integral of f from a to b equals F(b) − F(a), where F is any antiderivative of f. It connects the derivative and the integral as inverse operations. Evaluating an integral this way requires knowing how to differentiate, since you must recognize F from its derivative.',
  ],
  items: [
    concept('Derivatives', 'd/dx', 1, 'The derivative of f at x measures the instantaneous rate of change of f.'),
    concept('Optimization', 'max', 1, 'set the derivative equal to zero and check the critical points'),
    link('Optimization', 'Derivatives', 1, 'set the derivative equal to zero and check the critical points'),
    concept('Riemann sums', 'Σ', 2, 'A Riemann sum approximates the area under a curve by adding the areas of thin rectangles.'),
    concept('Integrals', '∫', 2, 'The definite integral is the limit of Riemann sums as the rectangles become infinitely thin.'),
    link('Integrals', 'Riemann sums', 2, 'The definite integral is the limit of Riemann sums as the rectangles become infinitely thin.', 'is the limit of'),
    link('Integrals', 'Derivatives', 3, 'Evaluating an integral this way requires knowing how to differentiate'),
    concept('Fundamental theorem', 'FTC', 3, 'the integral of f from a to b equals F(b) − F(a), where F is any antiderivative of f'),
    link('Fundamental theorem', 'Integrals', 3, 'the integral of f from a to b equals F(b) − F(a), where F is any antiderivative of f'),
    link('Fundamental theorem', 'Derivatives', 3, 'It connects the derivative and the integral as inverse operations.', 'connects'),
  ],
}

const week6: SampleDoc = {
  id: 'sample-calc-week6',
  name: 'Week 6 slides – Multivariable.pdf',
  context: 'week 6 slides',
  created_at: '2026-10-26T18:30:00Z',
  status: 'approved',
  pages: [
    'A partial derivative differentiates a function of several variables with respect to one variable while holding the others constant. Computing a partial derivative uses the same rules as the ordinary derivative.',
    'The gradient of f is the vector of its partial derivatives. It points in the direction of steepest increase.',
    'A double integral adds up a function over a region in the plane. It is evaluated as an iterated integral: integrate with respect to one variable, then the other. A triple integral extends the double integral to a solid region in space.',
  ],
  items: [
    concept('Partial derivatives', '∂', 1, 'A partial derivative differentiates a function of several variables with respect to one variable while holding the others constant.'),
    link('Partial derivatives', 'Derivatives', 1, 'Computing a partial derivative uses the same rules as the ordinary derivative.'),
    concept('Gradient', '∇f', 2, 'The gradient of f is the vector of its partial derivatives.'),
    link('Gradient', 'Partial derivatives', 2, 'The gradient of f is the vector of its partial derivatives.', 'is built from'),
    concept('Double integrals', '∬', 3, 'A double integral adds up a function over a region in the plane.'),
    link('Double integrals', 'Integrals', 3, 'It is evaluated as an iterated integral: integrate with respect to one variable, then the other.'),
    concept('Triple integrals', '∭', 3, 'A triple integral extends the double integral to a solid region in space.'),
    link('Triple integrals', 'Double integrals', 3, 'A triple integral extends the double integral to a solid region in space.', 'extends'),
  ],
}

const week9: SampleDoc = {
  id: 'sample-calc-week9',
  name: 'Week 9 slides – Vector calculus.pdf',
  context: 'week 9 slides',
  created_at: '2026-11-12T19:05:00Z',
  status: 'pending',
  pages: [
    'A vector field assigns a vector to every point in the plane or in space. The divergence of a vector field F = (P, Q) is the sum of partial derivatives ∂P/∂x + ∂Q/∂y. It measures how much the field spreads out from a point.',
    'A line integral adds up a vector field along a curve. It is computed by parametrizing the curve and evaluating an ordinary integral in the parameter t.',
    "Green's theorem states that the line integral of F around a closed curve C equals the double integral of ∂Q/∂x − ∂P/∂y over the region D enclosed by C. Using Green's theorem, a difficult line integral can be traded for a double integral over the enclosed region.",
  ],
  items: [
    concept('Vector fields', 'F', 1, 'A vector field assigns a vector to every point in the plane or in space.'),
    concept('Divergence', '∇·F', 1, 'It measures how much the field spreads out from a point.'),
    link('Divergence', 'Vector fields', 1, 'The divergence of a vector field F = (P, Q) is the sum of partial derivatives'),
    link('Divergence', 'Partial derivatives', 1, 'The divergence of a vector field F = (P, Q) is the sum of partial derivatives', 'is a sum of'),
    concept('Line integrals', '∮', 2, 'A line integral adds up a vector field along a curve.'),
    link('Line integrals', 'Vector fields', 2, 'A line integral adds up a vector field along a curve.'),
    link('Line integrals', 'Integrals', 2, 'evaluating an ordinary integral in the parameter t'),
    concept("Green's theorem", 'Green', 3, "Green's theorem states that the line integral of F around a closed curve C equals the double integral of"),
    link("Green's theorem", 'Line integrals', 3, "Green's theorem states that the line integral of F around a closed curve C equals the double integral of"),
    link("Green's theorem", 'Double integrals', 3, 'a difficult line integral can be traded for a double integral over the enclosed region'),
    // Adds evidence to a concept that is already in the graph (a proposed merge).
    concept('Double integrals', '∬', 3, 'a difficult line integral can be traded for a double integral over the enclosed region'),
    // Deliberately unsupported: this sentence is not on page 3, so grounding drops it.
    concept("Stokes' theorem", 'Stokes', 3, "Stokes' theorem generalizes Green's theorem to surfaces in space."),
  ],
}

/** Offered inside the calculus sample as extra material the student can add. */
const officeHours: SampleDoc = {
  id: 'sample-calc-office-hours',
  name: 'Office hours memo (transcript).txt',
  context: 'voice memo from office hours',
  created_at: '',
  status: 'pending',
  pages: [
    'So the divergence theorem is the three-dimensional version of what we did last week. It says the flux of F out through a closed surface equals the triple integral of the divergence of F over the solid inside. Flux is a surface integral: you add up how much of the field passes through each little patch of the surface, and each patch is set up as a double integral over the parameters. Remember that divergence measures how much the field spreads out from a point, so the theorem is just adding up all that spreading.',
  ],
  items: [
    concept('Surface integrals', '∯', 1, 'Flux is a surface integral: you add up how much of the field passes through each little patch of the surface'),
    link('Surface integrals', 'Vector fields', 1, 'you add up how much of the field passes through each little patch of the surface'),
    link('Surface integrals', 'Double integrals', 1, 'each patch is set up as a double integral over the parameters'),
    concept('Divergence theorem', 'Gauss', 1, 'the flux of F out through a closed surface equals the triple integral of the divergence of F over the solid inside'),
    link('Divergence theorem', 'Surface integrals', 1, 'the flux of F out through a closed surface equals the triple integral of the divergence of F over the solid inside'),
    link('Divergence theorem', 'Triple integrals', 1, 'the flux of F out through a closed surface equals the triple integral of the divergence of F over the solid inside'),
    link('Divergence theorem', 'Divergence', 1, 'the flux of F out through a closed surface equals the triple integral of the divergence of F over the solid inside'),
    concept('Divergence', '∇·F', 1, 'divergence measures how much the field spreads out from a point'),
  ],
}

/** The same text and proposals as the Python backend's `/api/demo`. */
const hashTables: SampleDoc = {
  id: 'demo-hash-tables',
  name: 'Hash tables · sample notes',
  context: 'sample notes',
  created_at: '2026-11-13T16:00:00Z',
  status: 'pending',
  pages: [
    'A hash table maps keys to buckets. A hash function determines the bucket for a key. Chaining resolves collisions in a hash table by storing several entries in one bucket.',
  ],
  items: [
    concept('Hash table', '{ }', 1, 'A hash table maps keys to buckets.'),
    concept('Hash function', 'h(k)', 1, 'A hash function determines the bucket for a key.'),
    concept('Chaining', '→→', 1, 'Chaining resolves collisions in a hash table'),
    link('Chaining', 'Hash table', 1, 'Chaining resolves collisions in a hash table', 'resolves collisions in'),
  ],
}

export type SampleNotebook = {
  id: string
  title: string
  docs: SampleDoc[]
  packs: SampleDoc[]
  /** Things the student added by hand: concepts with no source, and links to them. */
  manual: { created_at: string; concepts: { title: string; symbol: string; comment: string }[]; links: [string, string][] }
  target: string | null
}

export const SAMPLE_NOTEBOOKS: SampleNotebook[] = [
  {
    id: 'sample-calculus',
    title: 'Calculus III (sample)',
    docs: [review, week6, week9],
    packs: [officeHours],
    manual: {
      created_at: '2026-10-27T03:40:00Z',
      concepts: [{
        title: 'Limits', symbol: 'lim',
        comment: 'Not in the slides. The professor assumes it from Calc I, so review it before the midterm.',
      }],
      links: [['Derivatives', 'Limits'], ['Integrals', 'Limits']],
    },
    target: null,
  },
  {
    id: 'sample-hash-tables',
    title: 'Hash tables (sample)',
    docs: [hashTables],
    packs: [],
    manual: { created_at: '', concepts: [], links: [] },
    target: null,
  },
]
