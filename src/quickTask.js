// Question:
// After transcribing an audio file, you get back a list of segments, each with a start and end time in seconds. But some parts of the audio had no speech. Given the segments and the total audio duration, return all the silent gaps where no transcription exists.
// Note: Segments might overlap or be out of order.

// Example 1:
// Input:

//   duration = 60

//   segments = [[3, 10], [15, 20], [18, 30], [45, 55]]

// Output:

//   [[0, 3], [10, 15], [30, 45], [55, 60]]

// Example 2:
// Input:

// let duration1 = 60;

// let segments1 = [
//   [45, 55],
//   [3, 10],
//   [15, 20],
//   [18, 30],
// ];

// Output:

//   [[0, 3], [10, 15], [30, 45], [55, 60]]

// Example 3:
// Input:

let duration1 = 20;

let segments1 = [
  [0, 5],
  [5, 20],
];

// Output:

//   []   // no gaps — fully covered

// Your Response (You can use any language you’re comfortable with):
// NOTE: Write your response below
// duration = 60;

// segments = [
//   [45, 55],
//   [3, 10],
//   [15, 20],
//   [18, 30],
// ];

// let duration1 = 60;

// let segments1 = [
//   [3, 10],
//   [15, 20],
//   [18, 30],
//   [45, 55],
// ];

function findSilentGaps(duration, segments) {
  segments.sort((a, b) => a[0] - b[0]);

  let gap = [];
  let prevEnd = 0;
  for (let [start, end] of segments) {
    if (start > prevEnd) {
      gap.push([prevEnd, start]);
    }
    prevEnd = Math.max(prevEnd, end);
  }
  if (prevEnd < duration) {
    gap.push([prevEnd, duration]);
  }

  return gap;
}

console.log(findSilentGaps(duration1, segments1));
